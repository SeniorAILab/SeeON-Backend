# Deploy script agent rules - Naver Cloud VM

## Overview
`scripts/deploy/**` owns host bootstrap and VM-side deploy execution for the
production Compose image-pull topology.

## Where to look
- `ncloud-bootstrap.sh` - one-time root bootstrap: Docker, `deploy` user,
  `/opt/eldercare-fall-ai`, and swap.
- `ncloud-deploy.sh` - consumes the uploaded bundle, pulls explicit GHCR image
  tags, replays migration SQL, starts Compose, and runs one smoke check.
- `docs/runbooks/ncloud-vm-deploy.md` - operator-facing runbook that must match
  these scripts.

## Conventions
- Shell scripts are POSIX `sh` and run noninteractively with `set -eu`.
- `IMAGE_TAG` is required. Treat an empty tag as a deploy error, never as a
  signal to infer `latest`.
- The VM pulls already-built backend/front images and runs Docker Compose.
- Production DB schema replay is done by deploy tooling with `psql` from the
  Postgres container.
- Public exposure is `front` on port `80`; backend and DB stay internal to the
  Compose network.
- Cleanup may be best-effort only where failure cannot change deploy outcome;
  core deploy, migration, and smoke-check failures must exit non-zero.

## Anti-patterns
- No server-side application image builds or `git checkout` based deploys.
- No fallback image tag, branch, environment file, or alternate compose profile.
- No migrate image, Prisma CLI runtime migration, or backend app-start
  migration step.
- No automatic retry loop after failed pull, migration, `compose up`, or smoke
  check.
- No host-destructive operations outside the documented app root and Docker
  resources.
- No secret printing while handling `.env`, registry credentials, or SSH inputs.
