#!/usr/bin/env bash
# Exercise the published candidate by digest before release tags move.
set -euo pipefail

image="${1:?usage: docker-image-smoke.sh IMAGE FULL_SOURCE_SHA}"
expected_sha="${2:?expected full source SHA}"
[[ "$expected_sha" =~ ^[a-f0-9]{40}$ ]]
container=""
cleanup() {
  result=$?
  if [[ -n "$container" ]]; then
    if (( result != 0 )); then docker logs "$container" >&2 || true; fi
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  exit "$result"
}
trap cleanup EXIT

docker pull "$image"
docker run --rm -i "$image" sh -s < scripts/assert-orphan-reaping.sh
container="$(docker run --detach --publish 127.0.0.1::3100 \
  --env PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
  --env PAPERCLIP_MIGRATION_AUTO_APPLY=true \
  --env PAPERCLIP_OPEN_ON_LISTEN=false \
  "$image")"
port="$(docker port "$container" 3100/tcp | head -1 | sed 's/.*://')"
deadline=$((SECONDS + ${SMOKE_TIMEOUT_SECONDS:-180}))
ready=false
while (( SECONDS < deadline )); do
  test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
  if curl --fail --silent --max-time 3 "http://127.0.0.1:$port/api/health" | jq -e '.status == "ok"' >/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
test "$ready" = true
curl --fail --silent --max-time 10 "http://127.0.0.1:$port/" | grep -q '<div id="root"'
docker exec --env EXPECTED_SHA="$expected_sha" "$container" node --input-type=module -e '
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import path from "node:path";
  assert.equal(process.env.PAPERCLIP_BUILD_COMMIT, process.env.EXPECTED_SHA);
  const root = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "provider-pack.json"), "utf8"));
  assert.equal(manifest.payload.runnerSourceRevision, process.env.EXPECTED_SHA);
  assert.ok(Object.keys(manifest.payload.artifacts).length > 0);
  for (const artifact of Object.values(manifest.payload.artifacts)) fs.accessSync(path.join(root, artifact.path));
  fs.accessSync("/app/server/dist-runtime/index.mjs");
  fs.accessSync("/app/packages/paperclip-runner/dist/bin/paperclip-runnerd", fs.constants.X_OK);
  assert.doesNotMatch(fs.readFileSync("/app/.npmrc", "utf8"), /_authToken|_password|_auth\s*=/i);
'
echo "Image smoke passed: $image ($expected_sha)"
