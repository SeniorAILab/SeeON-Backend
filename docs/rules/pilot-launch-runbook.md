# API-first edge rollout and rollback

This runbook replaces the former one-off pilot procedure. The durable integration
is the versioned AI and ML API contract. Operators must not repair topology with
SQL, place facility identity in environment files, infer an image from a tag, or
use this runbook against JNU infrastructure.

Production mutation remains forbidden until the approved plan and final release
candidates are sealed. Todos 18-20 own the actual production windows.

## Required artifacts

The integration workspace must contain:

- `.omo/plans/edge-driven-facility-provisioning.md`
- `.omo/drafts/edge-driven-facility-provisioning.md` with
  `round_status: approved` and `approved_plan_sha256`
- `.omo/evidence/edge-driven-facility-provisioning/final-rc-seal.json`
- task evidence written before the current operation
- a pinned `known_hosts` entry and a SHA-256 baseline of the selected edge
  machine ID

The final seal has `schemaVersion: 2` and binds the approved plan SHA-256 to the
exact AI and ML repository identities, commit trees, Git SHAs, and four built
images. Every image record includes its digest reference, image ID, platform,
repository, and OCI source-revision label. Mutable tags are not release identities.
Any source change after sealing invalidates the seal and all review receipts.
Build new images, write a new seal, and rerun every review and gate.

Before any production command, export pointers, never credential values:

```sh
export EDGE_PROVISIONING_PLAN="$WS/.omo/plans/edge-driven-facility-provisioning.md"
export EDGE_PROVISIONING_DRAFT="$WS/.omo/drafts/edge-driven-facility-provisioning.md"
export EDGE_PROVISIONING_SEAL="$WS/.omo/evidence/edge-driven-facility-provisioning/final-rc-seal.json"
export EDGE_PROVISIONING_APPROVED_PLAN_SHA256='<independently approved plan digest>'
export EDGE_PROVISIONING_SEAL_SHA256='<independently recorded seal digest>'
```

## Local release-candidate gate

Run all five fixture commands before sealing and again on the exact sealed RCs:

```sh
cd "$AI_RC"
sh scripts/deploy/edge-provisioning-smoke.sh --fixture --dry-run
node scripts/deploy/verify-edge-provisioning-evidence.mjs --fixture
sh scripts/deploy/with-secret-fd.sh --fixture

cd "$ML_RC"
sh scripts/ops/cloud-enrollment-smoke.sh --fixture --dry-run
uv run python scripts/verify_scope_fidelity.py --fixture
```

Expected markers are:

```text
EDGE_PROVISIONING_SMOKE_FIXTURE_OK
EDGE_PROVISIONING_EVIDENCE_FIXTURE_OK
WITH_SECRET_FD_FIXTURE_OK
CLOUD_ENROLLMENT_SMOKE_FIXTURE_OK
SCOPE_FIDELITY_FIXTURE_OK
```

The fixtures reject plan or digest drift, unverified backups, held locks,
Jenkins/updater concurrency, unhealthy volumes, non-drained queues, insufficient
capacity, wrong host/key/machine identity, env-derived scope, destructive SQL,
mutable images, secret output, and leaked secret files.

## Capacity and concurrency gates

AI requires all of the following before release publication:

- deployment lock available and no Jenkins deployment running
- memory available plus free swap at least 1024 MiB
- filesystem free space at least 10 GiB
- database and media volumes healthy
- durable queues drained for the deployment boundary
- a validated `pg_dump -Fc` backup and retained previous release manifest
- legacy compatibility enabled through the rollback window

The edge requires all of the following before image replacement:

- strict SSH host-key checking against the pinned file
- target alias exactly `happy-nursing-home-raw`
- hostname matching the Happy Nursing Home signature and containing no JNU
  signature
- current machine-ID SHA-256 matching the first read-only baseline
- edge deployment lock available and updater idle
- clip-store free space at least 20 GiB
- named state volumes healthy and durable queues drained
- WAL checkpoint, SQLite online backups, `PRAGMA integrity_check`, file and parent
  fsync receipt, and retained previous image digests

Failure of any item aborts before release, updater, enrollment, restart, topology,
or media mutation.

## Ordered rollout

### 1. AI first

1. Acquire the AI deployment lock and reject concurrent Jenkins work.
2. Rehash the plan and verify the final seal.
3. Verify the capacity, queue, volume, backup, and previous-release readback.
4. Publish the next unused stable release containing the sealed AI SHA. Jenkins
   resolves the tag once and builds exact-SHA backend/front images.
5. Verify `/health` reports the sealed SHA and database `ok`.
6. Verify the v1 issuance, enrollment, topology, event, media, and download
   routes while legacy clients continue to work.
7. Keep `EDGE_TOKEN_PEPPER`, managed-admin inputs, and media secrets in the
   existing host secret store. Never print the host environment.

The read-only smoke consumes a redacted execution receipt only after its digest
is independently recorded. Schema 2 receipts contain sequenced command results,
timestamps, exit codes, and evidence hashes. A full lifecycle receipt includes
credential issue, enrollment, topology, heartbeat, event/clip download, rotation,
timeout retry, restart, and rollback-dry-run executions. The post-restart section
must have a newer generation and revalidate every lock, queue, volume, backup,
schema, scope, capacity, database, and compatibility predicate.

```sh
export EDGE_PROVISIONING_AI_READBACK="$EVIDENCE/ai-rollout-readback.json"
export EDGE_PROVISIONING_AI_READBACK_SHA256='<independently recorded receipt digest>'
sh scripts/deploy/edge-provisioning-smoke.sh --production --ai-only
```

### 2. ML images and runtime enrollment

Only after AI is healthy may the edge consume the sealed ML API and worker
digests. Follow the ML repository's `docs/runbooks/edge-image-publish.md` and
`docs/runbooks/worker-migration-rollback.md`.

Enrollment is runtime-only:

1. An AI SUPER_ADMIN issues a facility code and one-time token.
2. The token is transferred through an inherited descriptor with tracing,
   history, screenshots, HAR, video, and body capture disabled.
3. The ML local `PUT /api/v1/connection` calls
   `POST /api/v1/edge/enrollments/verify` and persists the canonical facility,
   installation, and generation in mode-0600 SQLite.
4. `POST /api/v1/connection/test` verifies the persisted principal.
5. `POST /api/v1/connection/sync-cameras` emits the registry-owned complete
   topology snapshot. Sync remains event-driven; no polling loop is added.

Facility ID and token must not appear in Compose, worker config, shell argv,
logs, evidence, screenshots, or static YAML.

## Secret descriptor launcher

The launcher reads one newline-free value from `SECRET_SOURCE_FD`, copies it to
a mode-0600 temporary file, opens descriptor 9, unlinks the pathname, and execs
the child with `EDGE_PROVISIONING_SECRET_FD=9`.

```sh
SECRET_SOURCE_FD=8 scripts/deploy/with-secret-fd.sh <command> 8< "$SECRET_POINTER"
```

The child reads `/dev/fd/$EDGE_PROVISIONING_SECRET_FD`. It must not interpolate
the value into argv or output. An unreadable, empty, or multiline descriptor
fails before the child runs.

## Rollback order

After v1 edge activation, rollback is always ML first:

1. Stop and drain v1 ML work.
2. Restore both ML API and worker to their recorded digest-pinned previous
   images without `down -v`.
3. Preserve clip store, model directory, API state, worker state, and SQLite
   backups.
4. Verify drained queues, legacy AI event/heartbeat/snapshot/media routes, and
   normal heartbeat.
5. Only then may AI perform a binary rollback using its previous release
   manifest. Never restore the AI database after post-v1 traffic.

Restore the pre-v1 ML SQLite snapshot only when the old image cannot read the
additive schema. Roll-forward re-enrolls through the API, reads current server
revision, and submits the exact registry snapshot. It never reconstructs scope
from environment values.

## Topology and media safety

- The edge camera registry is the sole topology source.
- Revision 1 may claim validated aliases, then SUPER_ADMIN approves the exact
  ownership-transfer manifest, then revision 2 reconciles the registry.
- Omissions are previewed and soft-deactivated only after an exact, unexpired
  confirmation. No wrapper issues hard deletes.
- Historical events and media remain readable.
- Validation traffic uses a temporary installation and validation grant and is
  excluded from ordinary lists, alerts, SSE, email, and outbox delivery.
- Clip download is a derivative MP4 through the authorized attachment API. No
  edge URL or private frame enters evidence.

## Evidence and redaction

Evidence records hashes, exact Git SHAs, digest-pinned images, counts, status
codes, schema versions, backup filenames/hashes/sizes, lock state, capacity, and
named OK markers. It never records passwords, bearer tokens, private keys,
credential-bearing URLs, RTSP URLs, host environment content, camera locations,
private media, or raw machine IDs.

Final plan compliance is read-only:

```sh
node "$AI_RC/scripts/deploy/verify-edge-provisioning-evidence.mjs" \
  --plan "$EDGE_PROVISIONING_PLAN" \
  --plan-sha256 "$APPROVED_PLAN_SHA256" \
  --evidence "$EVIDENCE" \
  --ai "$AI_RC" \
  --ml "$ML_RC" \
  --seal-sha256 "$EDGE_PROVISIONING_SEAL_SHA256"
```

Proceed only on `PLAN_COMPLIANCE_OK`. A failed or partially completed smoke is a
stop condition, not permission to improvise SQL, environment identity, an
alternate host, or a mutable image.
