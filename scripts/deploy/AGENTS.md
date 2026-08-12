# Deploy script agent rules — iwinv release CD

## Overview
`scripts/deploy/**` owns iwinv host bootstrap and deploy execution for this
backend-only repository. Jenkins builds and deploys the backend and API ingress
images; direct host use is limited to an explicit rollback or database restore.
The SeeON-Front dashboard deploys from its own repository and is never built,
imaged, or started here.

## Where to look
- `Jenkinsfile` — resolves a published production release, requires its GitHub
  `CI gate=success`, builds exact-SHA backend and API-ingress images, captures
  the Edge continuity receipt, then invokes deploy.
- `iwinv-deploy.sh` — deploys exact local SHA-tagged images, validates the live
  `repo_clips` mount, backs up PostgreSQL, classifies candidate migrations,
  migrates, starts Compose, and verifies health/version.
- `iwinv-deploy.test.sh` — mocked dry-run and production-path contracts for
  gating, retention, rollback/restore ordering, health, and failure propagation.
- `api-ingress-image.test.sh` — Docker-level exact-SHA API ingress image contract.
- `jenkins-controller-image.test.sh` — linux/amd64 controller image, pinned plugin,
  jq CI-gate predicate, and host-mounted Docker CLI service contract.
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
  `"schema":"2"` is schema 2. Writers publish backend-only schema 2 (backend +
  API ingress images). Schema-1 and transitional schema-2 manifests, which name
  an embedded frontend image from the pre-extraction combined repository,
  remain readable for historical pointer compatibility only; no such image is
  built or deployed anymore. Both readers use the
  dependency-free POSIX fixed-grammar validator: one canonical printable-ASCII
  JSON line, one final LF, at most 4096 bytes, exact key order, and strict field
  forms. Node and jq are deliberately not runtime dependencies. Task 7 host
  provisioning must retain the standard POSIX tools used by that validator
  (`awk`, `cat`, `cmp`, `grep`, `mktemp`, `rm`, `sed`, `tail`, `tr`, and `wc`).
  Once schema 2 is current, a schema-1-only deploy script must never be restored
  independently: it cannot read the current pointer. Restore or roll back
  application releases only with a dual-read deploy script.
- Backend and API ingress images use commit SHA tags only. Never use `latest`
  or a release-tag image.

## Invariants
- Jenkins resolves the release tag once through the deploy-key authenticated
  remote lookup, then deploys only the resulting 40-character lowercase SHA.
  Never infer a branch, SHA, image, env file, or Compose profile.
- Server-side application builds are allowed only inside Jenkins and only as
  `eldercare-backend:<sha>` and `eldercare-api-ingress:<sha>`. The pinned
  controller image must provide jq for GitHub API JSON; every POSIX command
  listed in the release-manifest validator contract remains required.
- Repository checkout is `/opt/eldercare-fall-ai/repo`; backups are under
  `/opt/eldercare-fall-ai/backups/db/`, releases under
  `/opt/eldercare-fall-ai/releases/` (legacy host paths retained on the
  server). The API ingress binds only host loopback (`127.0.0.1:3001`); backend
  and database remain internal. Caddy owns public exposure of the API.
- Event-media bundle backup is not an iwinv deployment prerequisite. Jenkins,
  readiness, and deploy must not call `event-media-backup.sh`, require an
  off-host destination, or consume its receipt. The script remains optional,
  explicitly manual operator recovery tooling with a separate test gate.
- Before migration, require the exact named `repo_clips` volume and verify that
  the one running backend mounts it at `/app/backend/clips` readably. Capture an
  Edge heartbeat seed, create a `pg_dump -Fc` backup, and validate it with
  `pg_restore --list`. Candidate migrations must descend from the current
  release and pass the comment/string-aware additive classifier. Audit Prisma
  history before `migrate deploy`; migrations run once from deploy tooling,
  never on app start.
- Deployment and pruning may remove only individually classified stale images
  and manifests. They must never run broad image/system pruning or remove/prune
  Docker volumes; current and previous manifest images stay protected.
- Fail on the first resolution, checkout, build, preflight, backup, migration,
  Compose, or health error. No hidden retry, automatic rollback, alternate path,
  or secret output.
- The prod backend image compiles the full seed to `dist-tools/prisma/seed.js`
  (nokyang demo + super-admin) alongside `seed-super-admin.js`. A one-time
  destructive DB reset reseeds with `node dist-tools/prisma/seed.js` (or
  `pnpm --dir backend db:seed:prod`) after `prisma migrate deploy`; it requires
  `DIRECT_URL` and `NOKYANG_ADMIN_PASSWORD` and never logs secrets. Routine
  deploys still run only migrate deploy + super-admin bootstrap.

## Jenkins controller and job seed
- `infra/jenkins/` is the versioned source of truth for the pinned controller
  image, plugin lock, and `/opt/jenkins` Compose service contract. Replace it
  only through `docs/rules/jenkins-controller-replacement.md`; preserve the
  bind-mounted Jenkins home and immediate prior-image rollback.
- `scripts/deploy/jenkins-job-seed.groovy` is the versioned source of truth for
  the Jenkins Job DSL seed. The server copy at `/opt/jenkins/jobs.groovy` is
  reapplied by CasC on every Jenkins restart and must stay byte-identical to
  this file; update both in the same change.
- Both the seed checkout and the release resolver use the repository-owned
  `seeon-backend-github-deploy-key`; do not restore the source-repository
  `eldercare-github-deploy-key` pipeline reference.

## Anti-patterns
- No GHCR, GitHub Actions image build, SSH deploy, `latest`, fallback ref/image/env,
  or automatic retry/rollback path.
- No ML deployment, ML image build, or ML service in this CD path; ML remains
  edge-only.
- No frontend image build, frontend service, or frontend Compose entry;
  transitional frontend fields exist only in the manifest READ path.
