import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkDockerHubRepository } from "../../../scripts/ci/dockerhub-repository.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const ci = read(".github/workflows/ci.yml");
const pr = read(".github/workflows/pr.yml");
const docker = read(".github/workflows/publish-image.yml");
const jobs = (source) => new Map([...source.split(/^jobs:\n/m)[1].matchAll(/^  ([a-z_][a-z_0-9]*):\n([\s\S]*?)(?=^  [a-z_][a-z_0-9]*:\n|(?![\s\S]))/gm)]
  .map(([, name, body]) => [name, body]));

test("active workflows are repository-owned and verification receives no external credentials", () => {
  assert.deepEqual(readdirSync(`${root}.github/workflows`).sort(), ["ci.yml", "pr.yml", "publish-image.yml"]);
  for (const source of [ci, pr, docker]) {
    assert.doesNotMatch(source, /uses: (?:paperclipai|AlexFrontegg)\/paperclip\/|runs-on\/fleet=|refs\/heads\/master|secrets:\s*inherit/);
  }
  for (const source of [ci, pr]) assert.doesNotMatch(source, /secrets\.|pull_request_target|contents: write|packages: write/);
  assert.match(pr, /branches: \[deploy\]/);
  assert.match(pr, /if: \$\{\{ !github\.event\.pull_request\.draft \}\}\n\s+uses: \.\/\.github\/workflows\/ci.yml/);
});

test("the image smoke starts the server with a bind mode the server accepts", async () => {
  const { validateConfiguredBindMode } = await import("../../../packages/shared/src/network-bind.ts");
  const productionStage = read("Dockerfile").split(/^FROM base AS production$/m)[1];
  const imageSetting = (name) => productionStage.match(new RegExp(`\\b${name}=(\\S+)`))[1];
  const smokeMode = read("scripts/ci/docker-image-smoke.sh").match(/PAPERCLIP_DEPLOYMENT_MODE=(\w+)/)?.[1];
  const errors = validateConfiguredBindMode({
    deploymentMode: smokeMode ?? imageSetting("PAPERCLIP_DEPLOYMENT_MODE"),
    deploymentExposure: imageSetting("PAPERCLIP_DEPLOYMENT_EXPOSURE"),
    host: imageSetting("HOST"),
  });
  assert.deepEqual(errors, []);
});

test("the completion gate rejects failed, cancelled, skipped, and missing verification lanes", () => {
  const all = jobs(ci);
  const required = all.get("required");
  const names = required.match(/needs: \[([^\]]+)\]/)[1].split(",").map((value) => value.trim());
  assert.deepEqual(names.sort(), [...all.keys()].filter((name) => name !== "required").sort());
  assert.match(required, /if: always\(\)/);
  const expression = required.match(/jq -e '([^']+)'/)[1];
  const results = Object.fromEntries(names.map((name) => [name, { result: "success" }]));
  const check = (value) => spawnSync("jq", ["-e", expression], { input: JSON.stringify(value), encoding: "utf8" }).status;
  assert.equal(check(results), 0);
  for (const name of names) {
    for (const result of ["failure", "cancelled", "skipped", null]) {
      assert.notEqual(check({ ...results, [name]: { result } }), 0, `${name}: ${result} must block completion`);
    }
  }
  assert.notEqual(check({}), 0);
});

test("active general shards cover every server test once including the explicit native lane", () => {
  const matrix = [...ci.matchAll(/\{ group: ([^,]+), index: (\d+), count: (\d+) \}/g)]
    .map(([, group, index, count]) => ({ group, index, count }));
  const inventory = (args) => {
    const result = spawnSync(process.execPath, ["scripts/run-vitest-stable.mjs", "--mode", "general", ...args, "--dry-run"], {
      cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const full = inventory(["--group", "general-server", "--shard-index", "0", "--shard-count", "1"]);
  const selected = matrix.filter(({ group }) => group === "general-server-without-chat-or-native-runner")
    .flatMap(({ group, index, count }) => inventory(["--group", group, "--shard-index", index, "--shard-count", count]).selectedGeneralServerSuites);
  const native = inventory(["--group", "general-server-native-runner"]).selectedGeneralServerSuites;
  assert.match(jobs(ci).get("native_server"), /pnpm test:run:general -- --group general-server-native-runner/);
  const actual = [...selected, ...native, "server/src/__tests__/chat-channels.integration.test.ts"];
  assert.equal(new Set(actual).size, actual.length, "server partitions must not overlap");
  assert.deepEqual(actual.sort(), full.selectedGeneralServerSuites.sort());
  for (const [group, count] of [["general-chat", 3], ["general-workspaces-a", 2]]) {
    const entries = matrix.filter((entry) => entry.group === group);
    assert.deepEqual(entries.map((entry) => Number(entry.index)), Array.from({ length: count }, (_, i) => i));
    assert.ok(entries.every((entry) => Number(entry.count) === count));
  }
  for (const group of ["general-workspaces-b", "general-workspaces-c"]) {
    assert.equal(matrix.filter((entry) => entry.group === group && entry.count === "0").length, 1);
  }
  // Avoid the legacy PR-only wrapper implicitly adding the native group again.
  assert.doesNotMatch(pr, /^name: PR$/m);
});

test("registry jobs depend on successful authorization, source checks, and image smoke", () => {
  const all = jobs(docker);
  assert.match(all.get("verify"), /needs: authorize\n\s+uses: \.\/\.github\/workflows\/ci.yml/);
  assert.match(all.get("build"), /needs: \[authorize, verify\]/);
  assert.match(all.get("publish"), /needs: \[authorize, verify, build\]/);
  const guard = all.get("authorize");
  const script = guard.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
  const authorize = (env) => spawnSync("bash", ["-e", "-c", script], { env: { ...process.env, ...env } }).status;
  const valid = { REPOSITORY: "frontegg/paperclip", REF: "refs/heads/deploy", EVENT: "push" };
  assert.equal(authorize(valid), 0);
  assert.equal(authorize({ ...valid, EVENT: "workflow_dispatch" }), 0);
  for (const change of [{ REPOSITORY: "someone/paperclip" }, { REF: "refs/heads/feature" }, { EVENT: "pull_request" }]) {
    assert.notEqual(authorize({ ...valid, ...change }), 0);
  }
  const build = all.get("build");
  assert.match(build, /target: production/);
  assert.match(build, /PAPERCLIP_BUILD_COMMIT=\$\{\{ github.sha \}\}/);
  assert.match(build, /platform: linux\/amd64/);
  assert.match(build, /platform: linux\/arm64/);
  assert.ok(build.indexOf("docker-image-smoke.sh") < build.indexOf("name: Export the verified digest"));
  assert.doesNotMatch(build, /secrets\.(?:NPM|OPENAI|ANTHROPIC)|NPM_TOKEN|no-frozen-lockfile/);
  assert.match(all.get("publish"), /\[\[ "\$current" == "\$GITHUB_SHA" \]\]/);
  assert.match(all.get("publish"), /--tag "\$DOCKERHUB_IMAGE:latest" "\$DOCKERHUB_IMAGE@\$digest"/);
});

test("source checks and images share a frozen lockfile without npm credentials", () => {
  const setup = read(".github/actions/setup-paperclip/action.yml");
  const dockerfile = read("Dockerfile");
  assert.match(setup, /pnpm install --frozen-lockfile/);
  assert.match(dockerfile, /^RUN pnpm install --frozen-lockfile$/m);
  assert.doesNotMatch(setup + docker, /no-frozen-lockfile|NPM_TOKEN|_authToken/);
});

test("Docker Hub preflight rejects absent, public-by-accident, or unwritable destinations without exposing credentials", async () => {
  const input = { image: "frontegg/paperclip", visibility: "private", username: "ci-user", token: "secret-must-not-appear" };
  const info = { namespace: "frontegg", name: "paperclip", is_private: true, permissions: { write: true } };
  const fixture = (repository = info, status = 200) => async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url.endsWith("/auth/token")) {
      assert.deepEqual(JSON.parse(options.body), { identifier: input.username, secret: input.token });
      return Response.json({ access_token: "short-lived-token" });
    }
    assert.equal(url, "https://hub.docker.com/v2/namespaces/frontegg/repositories/paperclip");
    assert.equal(options.headers.Authorization, "Bearer short-lived-token");
    return Response.json(repository, { status });
  };
  assert.deepEqual(await checkDockerHubRepository(input, fixture()), { image: input.image, visibility: "private" });
  for (const repository of [{ ...info, is_private: false }, { ...info, name: "other" }, { ...info, permissions: { write: false } }, {}]) {
    await assert.rejects(checkDockerHubRepository(input, fixture(repository)));
  }
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(checkDockerHubRepository(input, fixture({ message: input.token }, status)), (error) => {
      assert.doesNotMatch(error.message, /secret-must-not-appear/);
      return error.message.includes(`HTTP ${status}`);
    });
  }
  await assert.rejects(checkDockerHubRepository({ ...input, image: "ghcr.io/frontegg/paperclip" }, fixture()));
  await assert.rejects(checkDockerHubRepository({ ...input, token: "" }, fixture()));
  await assert.rejects(checkDockerHubRepository(input, async () => new Response("secret-must-not-appear")), (error) => {
    assert.equal(error.message, "Docker Hub returned an invalid JSON response");
    return true;
  });
  assert.equal((docker.match(/run: node scripts\/ci\/dockerhub-repository.mjs/g) ?? []).length, 2);
});
