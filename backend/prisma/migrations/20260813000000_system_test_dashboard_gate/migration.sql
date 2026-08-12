-- Facility-level SYSTEM_TEST rows are deliberately outside resident/camera/room semantics.
ALTER TABLE "events"
  ALTER COLUMN "camera_id" DROP NOT NULL,
  ALTER COLUMN "space_id" DROP NOT NULL,
  ADD COLUMN "retention_expires_at" TIMESTAMP(3);

ALTER TABLE "alerts"
  ALTER COLUMN "space_id" DROP NOT NULL,
  ALTER COLUMN "probability" DROP NOT NULL;

ALTER TABLE "edge_validation_grants"
  ADD COLUMN "capability" VARCHAR(32);

ALTER TABLE "edge_validation_grants"
  ADD CONSTRAINT "edge_validation_grants_capability_check"
  CHECK ("capability" IS NULL OR "capability" = 'SYSTEM_TEST');

ALTER TABLE "events"
  ADD CONSTRAINT "events_system_test_shape_check"
  CHECK (
    (
      "type" = 'SYSTEM_TEST'
      AND "camera_id" IS NULL
      AND "space_id" IS NULL
      AND "confidence" IS NULL
      AND "config_version" IS NULL
      AND "model_version" IS NULL
      AND "detector_version" IS NULL
      AND "operating_threshold" IS NULL
      AND "snapshot_key" IS NULL
      AND "clock_source" IS NULL
      AND "clip_id" IS NULL
      AND "validation_run_id" IS NOT NULL
      AND "retention_expires_at" IS NOT NULL
    )
    OR
    (
      "type" <> 'SYSTEM_TEST'
      AND "camera_id" IS NOT NULL
      AND "space_id" IS NOT NULL
      AND "retention_expires_at" IS NULL
    )
  );

ALTER TABLE "alerts"
  ADD CONSTRAINT "alerts_system_test_shape_check"
  CHECK (
    (
      "type" = 'SYSTEM_TEST'
      AND "camera_id" IS NULL
      AND "space_id" IS NULL
      AND "probability" IS NULL
      AND "snapshot_key" IS NULL
    )
    OR
    (
      "type" <> 'SYSTEM_TEST'
      AND "space_id" IS NOT NULL
      AND "probability" IS NOT NULL
    )
  );
