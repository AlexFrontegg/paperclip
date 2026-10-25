# Frontegg CI and Docker Hub

The maintained branch is `deploy` in `frontegg/paperclip`. CI is owned by this
repository; it does not call upstream or AlexFrontegg reusable workflows.

## Pull requests

`pr.yml` calls the repository-local `ci.yml` from the same commit. The workflow
checks repository policies, TypeScript, builds, general and serialized Vitest
partitions, native Runner TypeScript/Rust contracts, native server integrations,
browser journeys with fixture providers, and Docker build-context integrity.
It needs no Docker Hub, npm, cloud, or model-provider credentials.

`CI required` depends on every verification lane and rejects failures,
cancellations, and skipped lanes. Configure branch protection for `deploy` to
require the check emitted by `ci / required` (`CI required` in the job display).
Use the exact check name shown by the first PR run. Keep the existing review
requirement and assign Frontegg maintainers to `.github/**` in CODEOWNERS.

Node 24.11 or newer, pnpm 9.15.4, and the Runner's `rust-toolchain.toml` are the
runtime/toolchain baseline. GitHub-hosted Linux runners execute all active jobs.
The existing server/chat/route/browser partitions keep their process and database
isolation. Runner integration has an explicit lane on both PR and publish runs.

## Dependency policy

Commit `pnpm-lock.yaml` with dependency, workspace, override, or patch changes.
Generate it with `pnpm install` using the repository's pinned pnpm version.
CI and Docker use `pnpm install --frozen-lockfile` and fail on a stale lockfile.
There is no automated refresh PR and no per-job dependency re-resolution.
After an upstream merge, resolve any manifest/lockfile conflicts locally and
commit the resulting lockfile together. This fork policy replaces the archived
upstream lockfile bot policy and inherited upstream release instructions.

The image still refreshes its globally installed provider CLIs weekly through
`CLI_TOOLS_CACHE_EPOCH`; several Dockerfile tool installs follow `@latest`.
A commit identifies source, not byte-identical rebuilds. Record the published
manifest digest for deployments and rollback.

## Docker Hub publication

`docker.yml` runs after a push to `deploy`, or a manual dispatch on `deploy`.
It verifies the triggering commit using the same `ci.yml` before building.
Dispatching on another branch or from a different repository fails authorization.
There is no application/infrastructure rollout in this workflow.

Configuration:

| Setting | Purpose |
| --- | --- |
| Repository variable `DOCKERHUB_IMAGE` | Destination, default `frontegg/paperclip` |
| Repository variable `DOCKERHUB_VISIBILITY` | Expected visibility, default `private`; set `public` only for an intentional public image |
| Organization secret `DOCKER_HUB_ACTION_USER` | Docker Hub publishing identity |
| Organization secret `DOCKER_HUB_ACTION_PASSWORD` | Token with push access to the destination |

Create the destination repository in Docker Hub and explicitly set its visibility
before the first publish. CI checks that it exists, has the configured visibility,
and permits this credential to push, before building and again before tagging.
The GitHub source repository is private; keep the image
private unless publishing its contents is intentional. The workflow does not
create repositories or change registry visibility. The existing organization
credentials must have write access to the chosen destination. Never put their
values in repository variables, build arguments, `.npmrc`, or build context.

Native AMD64 and ARM64 runners build `target: production` and push candidate
digests. Each exact digest must pass the real image smoke: process reaping,
server readiness, UI HTML, source commit, Runner executable, and remote provider
pack. Only after both pass does the publisher assemble the multi-platform image.
Build cache tags are separate per architecture and only publishing jobs log in.

Published tags:

- `sha-<full commit SHA>`: the source commit built by this run.
- `latest`: advanced only when the triggering commit is still the current
  `deploy` head. Publication runs are serialized and never cancel running builds.
- `buildcache-amd64` and `buildcache-arm64`: internal BuildKit caches, not releases.

The workflow summary reports the manifest digest. Pull or deploy that immutable
reference, for example `docker.io/frontegg/paperclip@sha256:<digest>`. A manual
rerun can rebuild a SHA tag, so use the digest when exact artifact identity matters.
The source/version and database migration labels remain attached to the images.

## Verification and maintenance

### Initial rollout

This repository originally had the PR and Docker workflows manually disabled.
Enable `pr.yml` in Actions before the first validation push. After this change
lands on `deploy`, enable the replacement `docker.yml` and dispatch it there.
Do not enable the old Docker workflow on `deploy` before merging: that definition
still publishes to GHCR. Once the PR check has completed, require its exact
`CI required` check name in branch protection. Enabling a workflow is repository
state, so committing its YAML alone does not perform that rollout step.

### Local checks

Run `node --test .github/scripts/tests/*.test.mjs` for workflow/helper regression
tests. Run `actionlint .github/workflows/*.yml` for workflow syntax and expression
checks. The image smoke can run locally against a stamped production build:

```sh
bash scripts/ci/docker-image-smoke.sh IMAGE FULL_SOURCE_SHA
```

The first hosted acceptance run must show all source lanes green, both native
image smokes green, and a successful authenticated pull from Docker Hub by
manifest digest. Registry permission failures remain visible and block tagging.

Unused upstream workflows are preserved in `.github/archive/workflows/`; GitHub
does not execute them. They include npm release/canary flows, upstream Cloud
deployment/proofs, Storybook publication, AWS routing, and paid evaluations.
Keep upstream syncs from restoring them to `.github/workflows/` automatically.
