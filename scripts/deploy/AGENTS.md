# Deploy script agent rules — iwinv release CD

## Overview
`scripts/deploy/**` owns iwinv host bootstrap and deploy execution. Jenkins builds
and deploys server-side application images; direct host use is limited to an
explicit rollback or database restore.

## Where to look
- `Jenkinsfile` — resolves a published production release, requires its GitHub
  `CI gate=success`, builds exact-SHA backend/API-ingress/transitional-front
  images, takes safety receipts, then invokes deploy.
- `iwinv-deploy.sh` — deploys exact local SHA-tagged images, backs up PostgreSQL,
  migrates, starts Compose, and verifies health/version.
- `iwinv-deploy.test.sh` — mocked dry-run and production-path contracts for
  gating, retention, rollback/restore ordering, health, and failure propagation.
- `front-version-image.test.sh` — Docker-level exact-SHA version artifact contract.
- `iwinv-workflow-contract.test.mjs` — release trigger provenance, token,
  payload, and bounded-delivery contract.
- `/opt/eldercare-fall-ai/shared/.env` — host-only production environment contract;
  never print or track it.

## Release rules
- A published `vX.Y.Z` production release is the only normal production trigger.
  Issuing `pnpm release:prod -- vX.Y.Z` publishes the release and starts deployment.
- Production tags are exclusive to production. Their tagged commit must be
  contained by `origin/main`.
- Reissuing an identical or lower semantic version converges as a successful
  no-op; it must not rebuild or redeploy.
- The release resolver emits `RELEASE_TAG=`, `RELEASE_SHA=`, and `NO_OP=` for
  Jenkins consumption.
- Roll back with `iwinv-deploy.sh --rollback`. Rollback remains an explicit
  operator action.
- Release manifests are dual-read: absent `schema` is schema 1; quoted
  `"schema":"2"` is schema 2. Writers publish schema 2. Both readers use the
  dependency-free POSIX fixed-grammar validator: one canonical printable-ASCII
  JSON line, one final LF, at most 4096 bytes, exact key order, and strict field
  forms. Node and jq are deliberately not runtime dependencies. Task 7 host
  provisioning must retain the standard POSIX tools used by that validator
  (`awk`, `cat`, `cmp`, `grep`, `mktemp`, `rm`, `sed`, `tail`, `tr`, and `wc`).
  Once schema 2 is current, a schema-1-only deploy script must never be restored
  independently: it cannot read the current pointer. Restore or roll back
  application releases only with a dual-read deploy script.
- Backend, API ingress, and transitional frontend images use commit SHA tags
  only. Never use `latest` or a release-tag image.

## Invariants
- Jenkins resolves the release tag once through the deploy-key authenticated
  remote lookup, then deploys only the resulting 40-character lowercase SHA.
  Never infer a branch, SHA, image, env file, or Compose profile.
- Server-side application builds are allowed only inside Jenkins and only as
  `eldercare-backend:<sha>`, `eldercare-api-ingress:<sha>`, and during overlap
  `eldercare-front:<sha>`. The host must provision jq for GitHub API JSON plus
  every POSIX command listed in the release-manifest validator contract; none is
  optional.
- Repository checkout is `/opt/eldercare-fall-ai/repo`; backups are under
  `/opt/eldercare-fall-ai/backups/db/`, releases under
  `/opt/eldercare-fall-ai/releases/`. Frontend and API ingress bind only host
  loopback (`127.0.0.1:3000` and `127.0.0.1:3001`); backend and database remain
  internal. Caddy owns public exposure.
- Before migration, require a fresh content-addressed off-host media backup
  receipt, capture an Edge heartbeat seed, create a `pg_dump -Fc` backup, and
  validate it with `pg_restore --list`. Audit Prisma history before `migrate
  deploy`; migrations run once from deploy tooling, never on app start.
- Fail on the first resolution, checkout, build, preflight, backup, migration,
  Compose, or health error. No hidden retry, automatic rollback, alternate path,
  or secret output.
- The prod backend image compiles the full seed to `dist-tools/prisma/seed.js`
  (nokyang demo + super-admin) alongside `seed-super-admin.js`. A one-time
  destructive DB reset reseeds with `node dist-tools/prisma/seed.js` (or
  `pnpm --dir backend db:seed:prod`) after `prisma migrate deploy`; it requires
  `DIRECT_URL` and `NOKYANG_ADMIN_PASSWORD` and never logs secrets. Routine
  deploys still run only migrate deploy + super-admin bootstrap.

## Jenkins job seed
- `scripts/deploy/jenkins-job-seed.groovy` is the versioned source of truth for
  the Jenkins Job DSL seed. The server copy at `/opt/jenkins/jobs.groovy` is
  reapplied by CasC on every Jenkins restart and must stay byte-identical to
  this file; update both in the same change.

## Anti-patterns
- No GHCR, GitHub Actions image build, SSH deploy, `latest`, fallback ref/image/env,
  or automatic retry/rollback path.
- No ML deployment, ML image build, or ML service in this CD path; ML remains
  edge-only.
