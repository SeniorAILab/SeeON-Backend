# Deploy script agent rules — iwinv release CD

## Overview
`scripts/deploy/**` owns iwinv host deploy execution for this backend-only
repository. Jenkins builds and deploys the backend and API ingress images. The
SeeON-Front dashboard deploys from its own repository and is never built,
imaged, or started here.

## Deploy model
CI gates quality. Deploy is build, dump, migrate, up, health-sha. Rollback is a
re-run of the Jenkins job with `RELEASE_TAG=<previous tag>`.

- A deploy is blocked only by: release resolution, the GitHub `CI gate` check
  for the resolved SHA, the image builds, the pre-migration `pg_dump`,
  `prisma migrate deploy`, `docker compose up --wait`, and `/health` reporting
  the release SHA within `HEALTH_TIMEOUT_SECONDS` (default 120).
- Nothing else blocks or warns. Live-traffic and device signals (Edge
  heartbeats, overlap readiness) are not deploy gates: builds #47–#50 failed
  on them while production was healthy. Code and contract defects belong in CI.
- There is no server-side release state machine. Deploys do not read or write
  `releases/{current,previous,pending,<sha>}.json`; leftovers on the host are
  ignored and may be archived manually. The only state is
  `shared/release-images.env` (the exact image tags Compose runs).
- On failure after the dump, the database is never restored automatically. The
  deploy prints the exact operator command:
  `sh scripts/deploy/iwinv-deploy.sh --restore-db <dump> --ack-data-loss`.
  Each dump has a `<dump>.images.env` companion recording the images live before
  that deploy; `--restore-db` reinstates them, never the failed candidate.
- Jenkins runs the deploy helper from `origin/main` (`git archive`) against the
  release checkout (`APP_DIR`), so a `RELEASE_TAG` rollback to a tag older than
  this pipeline still uses the current helper.

## Where to look
- `Jenkinsfile` — Resolve release (`RELEASE_TAG` parameter or latest stable tag),
  Verify GitHub CI gate, Configure Buildx, Build backend, Build API ingress,
  Deploy (under the `eldercare-fall-ai-deploy` lock). Failure email in `post`.
- `iwinv-resolve-release.sh` — prints `RELEASE_TAG=` / `RELEASE_SHA=`; the tag
  must be a stable `vX.Y.Z` whose commit is reachable from `origin/main`.
- `iwinv-deploy.sh` — `--sha <sha>` deploy and `--restore-db <dump> --ack-data-loss`.
  Keep it under 150 lines.
- `iwinv-deploy.test.sh`, `iwinv-resolve-release.test.sh` — mocked-Docker and
  real-git contracts for the steps above and the Jenkinsfile stages.
- `api-ingress-image.test.sh`, `jenkins-controller-image.test.sh`,
  `iwinv-workflow-contract.test.mjs` — image, controller, and release-trigger contracts.
- `/opt/eldercare-fall-ai/shared/.env` — host-only production environment; never
  print or track it.

## Invariants
- Images are tagged by commit SHA only: `eldercare-backend:<sha>` and
  `eldercare-api-ingress:<sha>`, built only inside Jenkins. Never `latest`.
- Migrations run once from `iwinv-deploy.sh`, never on app start. The old
  backend and ingress are stopped before the dump, so the dump is consistent and
  no two backend versions overlap.
- Pre-migration dumps are `backups/db/deploy-<UTC>-<sha>.dump`; the newest 5
  are kept. Dumps with other names (for example legacy `normal-*.dump`) are
  never removed by tooling.
- Image cleanup removes only `eldercare-*` tags beyond the newest 3 per
  repository. Never run broad image/system pruning or remove/prune Docker volumes
  (`verify-deploy-source-safety.sh`).
- Every production Compose invocation goes through `controlled-compose.sh`, which
  drops inherited `EVENT_CLIPS_ENABLED`, CORS/cookie, and super-admin variables so
  only the owner-only env files supply them. Direct `compose:prod:up` uses
  `production-compose.sh`.
- Event-media bundle backup (`event-media-backup.sh`) is manual operator tooling,
  never a deploy prerequisite.
- The prod backend image compiles the full seed to `dist-tools/prisma/seed.js`
  alongside `seed-super-admin.js`. Routine deploys run only `migrate deploy` and
  the super-admin bootstrap; a one-time destructive reset reseeds with
  `node dist-tools/prisma/seed.js` and never logs secrets.

## Jenkins controller and job seed
- `infra/jenkins/` is the versioned source of truth for the pinned controller
  image, plugin lock, and `/opt/jenkins` Compose service contract. Replace it
  only through `docs/rules/jenkins-controller-replacement.md`.
- `scripts/deploy/jenkins-job-seed.groovy` is the versioned Job DSL seed. The
  server copy at `/opt/jenkins/jobs.groovy` must stay byte-identical; update both
  in the same change. The `RELEASE_TAG` parameter is declared in the Jenkinsfile.
- The seed checkout and the release resolver use the repository-owned
  `seeon-backend-github-deploy-key`.

## Anti-patterns
- No GHCR, GitHub Actions image build, SSH deploy, `latest`, or fallback ref/image.
- No automatic DB restore, and no deploy gate on external devices or live traffic.
- No ML or frontend image, service, or Compose entry in this CD path.
