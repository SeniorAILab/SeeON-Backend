# SYSTEM_TEST removal deployment order

This change is a one-way removal of the temporary `SYSTEM_TEST` validation
contract. It does not provide a compatibility window.

## Cross-repository compatibility

Before this backend revision is deployed:

1. Deploy the Edge/operations producer revision that no longer sends
   `type: SYSTEM_TEST`, `test_mode`, or validation-run `capability` fields and
   no longer calls the validation-run close or retention-purge endpoints.
2. Deploy `SeniorAILab/SeeON-Front` without SYSTEM_TEST controls, sentinel
   rendering, or calls to those removed admin endpoints. Ordinary Alert REST,
   dashboard SSE, and dashboard receipt contracts are unchanged.
3. Confirm no external generated client still contains the removed OpenAPI
   paths or schemas. Regenerate clients from `docs/openapi/v1.json` where used.

Sending a retired payload after cutover is expected to fail validation: the
sentinel event type is unsupported, `test_mode` and validation `capability` are
not DTO fields, and retired routes return 404.

## Backend and database cutover

Take a verified database backup before migration 49. Stop or fully drain every
old backend instance before applying the migration, then run `prisma migrate
deploy`, then start only the new backend image. Do not use an overlap rollout:
the old image references columns and routes that migration 49 removes.

The current production deploy path accepts additive migrations and uses overlap
readiness. It will intentionally reject this destructive migration. Before a
release is published, land a separately reviewed, one-migration authorization
and maintenance-mode/zero-overlap deploy procedure pinned to migration 49 and
its reviewed checksum. Do not weaken or bypass the general migration
classifier. This removal PR is not itself deployable through the current
production pipeline.

Migration 49 atomically deletes all relationally identified SYSTEM_TEST events,
their SYSTEM_TEST alerts, related dashboard receipts and alert notes, and
capability-marked validation grants. It drops only feature-specific database
objects and restores ordinary Event/Alert shape requirements. General dashboard
receipt history, validation grants without the capability, RLS policies, normal
runtime grants, media, heartbeat, auth, and alert delivery remain.

Rollback is restoration of the pre-migration backup together with the previous
backend image, not a down migration.
