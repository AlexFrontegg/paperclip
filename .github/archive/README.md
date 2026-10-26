# Archived upstream workflows

`workflows/` preserves the upstream and AlexFrontegg workflow definitions from
before this repository adopted Frontegg CI. GitHub only discovers workflows in
`.github/workflows/`, so these files do not run, publish packages, or use secrets.

The active entry points are:

- `.github/workflows/pr.yml`: verify pull requests targeting `deploy`.
- `.github/workflows/ci.yml`: shared, credential-free source verification.
- `.github/workflows/publish-image.yml`: verify `deploy`, build the `production` image,
  smoke-test each native architecture, and publish to Docker Hub.

Historical workflow regression tests read the preserved snapshots explicitly.
They do not certify the active pipeline; its coverage and publication gates are
tested in `.github/scripts/tests/frontegg-ci.test.mjs`.

Keep upstream workflow updates here during upstream syncs. Review any workflow
before moving it back into the active directory: the archived definitions refer
to upstream infrastructure, npm releases, GHCR, paid provider evaluations, and
upstream branch and credential policies. See `doc/CI.md` for the fork's policy.
