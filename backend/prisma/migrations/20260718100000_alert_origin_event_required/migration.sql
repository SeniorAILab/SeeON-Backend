-- Guarantee alerts.origin_event_id at the schema level. The Event API is the
-- only alert ingress, so every new alert already carries its origin event.
-- Legacy alerts written before 20260626150000_event_alarm_cutover may have
-- origin_event_id IS NULL; synthesize one immutable origin event per legacy
-- alert, link it, then SET NOT NULL. If any row remains unfillable (no camera
-- resolvable for the alert), SET NOT NULL fails and deployment stops.

-- alerts/events are FORCE RLS; the migration role must not be filtered while
-- backfilling. Restored below.
ALTER TABLE "events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "alerts" NO FORCE ROW LEVEL SECURITY;

-- events.camera_id is NOT NULL while alerts.camera_id is nullable: fall back
-- to any camera in the alert's facility+space when the alert has none.
INSERT INTO "events" (
    "id", "facility_id", "camera_id", "space_id", "type", "confidence",
    "detected_at", "created_at", "modified_at", "dedup_key", "snapshot_key"
)
SELECT
    'legacy-origin-' || a."id",
    a."facility_id",
    COALESCE(
        a."camera_id",
        (SELECT c."id" FROM "cameras" c
          WHERE c."facility_id" = a."facility_id" AND c."space_id" = a."space_id"
          ORDER BY c."id" LIMIT 1)
    ),
    a."space_id",
    a."type",
    a."probability",
    a."detected_at",
    a."created_at",
    a."created_at",
    'legacy-alert:' || a."id",
    a."snapshot_key"
FROM "alerts" a
WHERE a."origin_event_id" IS NULL
  AND COALESCE(
        a."camera_id",
        (SELECT c."id" FROM "cameras" c
          WHERE c."facility_id" = a."facility_id" AND c."space_id" = a."space_id"
          ORDER BY c."id" LIMIT 1)
      ) IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE "alerts" a
SET "origin_event_id" = 'legacy-origin-' || a."id"
WHERE a."origin_event_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "events" e
    WHERE e."facility_id" = a."facility_id"
      AND e."id" = 'legacy-origin-' || a."id"
  );

ALTER TABLE "alerts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;

ALTER TABLE "alerts" ALTER COLUMN "origin_event_id" SET NOT NULL;
