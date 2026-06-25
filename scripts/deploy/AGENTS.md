# Deploy script agent rules - Naver Cloud VM

## Overview
`scripts/deploy/**` owns host bootstrap and VM-side deploy execution for the
production Compose image-pull topology.

## Where to look
- `ncloud-bootstrap.sh` - one-time root bootstrap: Docker, `deploy` user,
  `/opt/eldercare-fall-ai`, and swap.
- `ncloud-deploy.sh` - consumes the uploaded bundle, pulls explicit GHCR image
  tags, backs up the database, applies Prisma migrations, starts Compose, and
  runs one smoke check.
- `scripts/release/manual-production-deploy.mjs` - current local production
  deploy path while Actions-backed CD is paused: builds/pushes SHA-tagged GHCR
  images, uploads the bundle, then invokes this VM pull-only deploy script.
- `docs/decisions/common/ADR-072-local-manual-production-deploy.md` - deploy
  decision of record; `.env.host.prod.example` - production env contract. VM
  access / bootstrap / operate notes are in the section below.

## Conventions
- Shell scripts are POSIX `sh` and run noninteractively with `set -eu`.
- `IMAGE_TAG` is required. Treat an empty tag as a deploy error, never as a
  signal to infer `latest`.
- The VM pulls already-built backend/front images and runs Docker Compose.
- Local manual deploy may build application images before upload, but only on
  the operator machine and only under the resolved commit SHA tag.
- Production DB migrations are done by deploy tooling with `prisma migrate
  deploy` from the backend image after `pg_dump -Fc` and `pg_restore --list`
  validation.
- Destructive schema reset is demo-only: `DEPLOY_DB_MODE=reset-demo` plus
  `ALLOW_DESTRUCTIVE_DB_RESET=I_UNDERSTAND_THIS_WIPES_PUBLIC_SCHEMA`.
- Public exposure is `front` on port `80`; backend and DB stay internal to the
  Compose network.
- Cleanup may be best-effort only where failure cannot change deploy outcome;
  core deploy, migration, and smoke-check failures must exit non-zero.

## Anti-patterns
- No server-side application image builds or `git checkout` based deploys.
- No fallback image tag, branch, environment file, or alternate compose profile.
- No migrate image or backend app-start migration step. Deploy tooling may run
  one-shot Prisma CLI commands from the backend image.
- No automatic retry loop after failed pull, migration, `compose up`, or smoke
  check.
- No host-destructive operations outside the documented app root and Docker
  resources.
- No secret printing while handling `.env`, registry credentials, or SSH inputs.

## VM access, bootstrap, operate

Target VM (Naver Cloud, registry-image pull topology): public IP `<retired-host>` (workflow default `vars.NCLOUD_HOST`), OS `ubuntu-24.04-base`, public `front` nginx on `:80`, while `backend:8080` and `db:5432` stay internal.

One-time access uses Naver Cloud's VPC server-access flow: the login PEM gets the initial administrator password in the console (Server > Server > select the instance > Manage servers > Get admin password > upload the PEM), and then you SSH as `root@<retired-host>`. Reference: Naver Cloud "Access Server (VPC)" guide.

Bootstrap (from a local checkout, as VM `root`):

```bash
ssh-keygen -t ed25519 -f <REDACTED_SSH_KEY_PATH> -C "eldercare-fall-ai ncloud deploy"
ssh root@<retired-host> \
  "DEPLOY_PUBLIC_KEY='$(cat <REDACTED_SSH_KEY_PATH>.pub)' sh -s" \
  < scripts/deploy/ncloud-bootstrap.sh
```

`ncloud-bootstrap.sh` installs Docker, enables SSH/Docker, creates the `deploy` user and `/opt/eldercare-fall-ai`, and adds a 2G swapfile for the 1 GB VM.

Production env lives in `/opt/eldercare-fall-ai/shared/.env` (or the GitHub secret `NCLOUD_ENV_FILE`); fill it from `.env.host.prod.example`. The deploy command path, DB modes (`migrate` default / `baseline-existing` / `reset-demo` / `skip`), and super-admin bootstrap (ADR-073) are owned by `scripts/release/manual-production-deploy.mjs`, so run it with `--dry-run` first:

```bash
pnpm deploy:prod:manual -- v0.1.0 --dry-run
pnpm deploy:prod:manual -- v0.1.0
```

Operate:

```bash
ssh -i <REDACTED_SSH_KEY_PATH> deploy@<retired-host>
cd /opt/eldercare-fall-ai/current
COMPOSE_PROFILES=full docker compose -f compose.yaml -f compose.prod.yaml ps
docker compose -f compose.yaml -f compose.prod.yaml logs --tail=100 front backend
```

GitHub Actions (`.github/workflows/deploy-ncloud.yml`) only deploys on explicit `workflow_dispatch`; the release trigger is paused (ADR-072). Set secrets `NCLOUD_SSH_PRIVATE_KEY` and `NCLOUD_ENV_FILE`, and optional vars `NCLOUD_HOST` and `NCLOUD_SSH_USER`.
