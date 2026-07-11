# Deploy script agent rules — iwinv Jenkins CD

## Overview
`scripts/deploy/**` owns the iwinv host bootstrap and deploy execution. Jenkins is
the only permitted server-side application-image builder and normal deploy initiator;
direct host use is limited to explicit rollback or database restore.

## Where to look
- `Jenkinsfile` — validates `SHA`/`REF`, checks out `origin/main`, builds
  `eldercare-backend:<sha>` and `eldercare-front:<sha>`, then invokes deploy.
- `iwinv-deploy.sh` — deploys exact local SHA-tagged images, backs up PostgreSQL,
  migrates, starts Compose, and verifies health/version.
- `iwinv-deploy.test.sh` — mocked dry-run and production-path contracts for
  gating, retention, rollback/restore ordering, health, and failure propagation.
- `front-version-image.test.sh` — Docker-level exact-SHA version artifact contract.
- `iwinv-workflow-contract.test.mjs` — GitHub trigger provenance, token, payload,
  and bounded-delivery contract.
- `/opt/eldercare-fall-ai/shared/.env` — host-only production environment contract;
  never print or track it.

## Invariants
- Accept only a 40-character lowercase hexadecimal `SHA` on `main`
  (`REF=refs/heads/main`); never infer a branch, SHA, image, env file, Compose
  profile, or `latest` tag.
- Server-side backend/front builds are allowed only inside Jenkins and only as
  `eldercare-backend:<sha>` and `eldercare-front:<sha>`. No local operator build,
  pull-based fallback, or `git checkout` deploy path exists.
- Repository checkout is `/opt/eldercare-fall-ai/repo`; backups are under
  `/opt/eldercare-fall-ai/backups/db/`, releases under `/opt/eldercare-fall-ai/releases/`.
  Frontend binds only host loopback
  `127.0.0.1:3000`, while backend and database remain internal. Caddy owns public
  exposure.
- Before migration, create a `pg_dump -Fc` backup and validate it with
  `pg_restore --list`. Migrations run once from deploy tooling, never on app start.
- Triggering remains disabled until the first manual deploy has passed public
  validation. GitHub enables it only with `vars.DEPLOY_ENABLED=true`.
- Fail on the first checkout, build, preflight, backup, migration, Compose, or
  health error. No hidden retry, automatic rollback, alternate path, or secret
  output. Rollback and restore are explicit operator actions.

## Anti-patterns
- No Naver Cloud, GHCR, GitHub Actions image build, SSH deploy, or manual-only
  production topology.
- No ML deployment, ML image build, or ML service in this CD path; ML remains
  edge-only.
The first production release was bootstrapped manually on 2026-07-11 (G004); this note also served as the harmless change for the rollback drill.

True-CD activation E2E: this merge is the first fully automatic deployment (issue #595 resolved).
