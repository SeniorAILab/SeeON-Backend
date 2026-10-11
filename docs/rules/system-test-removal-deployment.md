# SYSTEM_TEST removal deployment order

This change is a one-way removal of the temporary `SYSTEM_TEST` contract and
its remaining validation-run/grant subsystem. It does not provide a
compatibility window.

## Required cross-repository deployment order

Use exactly this order; there is no compatibility window:

1. Deploy the Edge/operations producer revision that no longer sends
   `type: SYSTEM_TEST`, `test_mode`, or validation-run `capability` fields and
   no longer calls the validation-run close or retention-purge endpoints.
2. Take and verify the database backup, fully drain every old backend instance,
   apply migration 49, and start only the new backend image. Do not use an
   overlap rollout: the old image references columns and routes that migration
   49 removes.
3. Before migration 50, verify `edge_validation_grants` has zero rows and
   `events.validation_run_id IS NOT NULL` has zero rows. Fully drain every
   migration-49 backend instance, apply migration 50, and start only the new
   backend image. There must be zero old/new backend overlap: migration 50
   aborts rather than nulling or converting any retired grant or linked event.
   It removes the exact two `VALIDATION_RUN` plus two `VALIDATION_RUN_CLOSE`
   operation-history rows and exact two `VALIDATION_RUN_CREATED` plus two
   `VALIDATION_RUN_CLOSED` audit-history rows before dropping the retired
   event discriminator, grant table policy/ACL/table, and enum.
4. Deploy `SeniorAILab/SeeON-Front` without SYSTEM_TEST controls, sentinel
   rendering, or calls to the removed admin endpoints. Regenerate external
   clients from `docs/openapi/v1.json` before deploying them.

Frontend removal must be last. The old backend exposes resolved SYSTEM_TEST
rows through unfiltered `GET /alerts`, resolved/history pagination, and SSE
replay; deploying the strict new Frontend before migration 49 purges those rows
can crash its parsers. After backend cutover, retired payloads fail validation:
the sentinel event type is unsupported, `test_mode` and validation `capability`
are not DTO fields, and retired routes return 404.

## Backend and database cutover

Historical note: when this removal was written, the deploy path used overlap
readiness and an additive-migration classifier that rejected migrations 49/50.
Since the 2026-10-11 plain-pipeline amendment (ADR-002), deploy runs build →
pg_dump → `prisma migrate deploy` → `compose up --wait` → `/health` sha with no
migration classifier. Destructive migrations are therefore gated only by code
review and CI: confirm the pre-migration dump exists and the operator restore
command (`iwinv-deploy.sh --restore-db <dump> --ack-data-loss`) before publishing
a release that carries one.

Migration 49 atomically deletes all relationally identified SYSTEM_TEST events,
their SYSTEM_TEST alerts, related dashboard receipts and alert notes, and
capability-marked validation grants. It drops only feature-specific database
objects and restores ordinary Event/Alert shape requirements. General dashboard
receipt history, Event/Alert RLS and ACLs, ordinary FKs, media, heartbeat, auth,
and alert delivery remain. Migration 50 then removes the now-empty generic
validation grant table and only its feature-specific database objects. Current
consumer audit found no Front, Edge, or non-SYSTEM_TEST producer using the
subsystem. The 2,283 permanent Edge rows are historical August 6 HTTP_403 fall
records (zero after schema 9/migration 49) and are not changed by this cutover.

Rollback is restoration of the pre-migration backup together with the previous
backend image, not a down migration.
