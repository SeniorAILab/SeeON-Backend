-- Alert.spaceId expand: preserve historical room anchors with verified camera or temporal assignment evidence.
BEGIN;

ALTER TABLE alerts ADD COLUMN space_id TEXT;

WITH camera_backfill AS (
  SELECT a.id, c.space_id
  FROM alerts a
  JOIN cameras c
    ON c.facility_id = a.facility_id
   AND c.id = a.camera_id
  WHERE a.camera_id IS NOT NULL
    AND c.space_id IS NOT NULL
)
UPDATE alerts a
SET space_id = cb.space_id
FROM camera_backfill cb
WHERE a.id = cb.id;

WITH assignment_candidates AS (
  SELECT
    a.id AS alert_id,
    ra.space_id,
    count(*) OVER (PARTITION BY a.id) AS covering_count
  FROM alerts a
  JOIN resident_assignments ra
    ON ra.facility_id = a.facility_id
   AND ra.resident_id = a.resident_id
   AND ra.started_at <= a.detected_at
   AND (ra.ended_at > a.detected_at OR ra.ended_at IS NULL)
  WHERE a.space_id IS NULL
), unique_assignment_backfill AS (
  SELECT alert_id, space_id
  FROM assignment_candidates
  WHERE covering_count = 1
)
UPDATE alerts a
SET space_id = uab.space_id
FROM unique_assignment_backfill uab
WHERE a.id = uab.alert_id;

DO $$
DECLARE
  unresolved_count INTEGER;
  missing_assignment_count INTEGER;
  multiple_assignment_count INTEGER;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM alerts
  WHERE space_id IS NULL;

  SELECT count(*) INTO missing_assignment_count
  FROM alerts a
  WHERE a.space_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM resident_assignments ra
      WHERE ra.facility_id = a.facility_id
        AND ra.resident_id = a.resident_id
        AND ra.started_at <= a.detected_at
        AND (ra.ended_at > a.detected_at OR ra.ended_at IS NULL)
    );

  SELECT count(*) INTO multiple_assignment_count
  FROM (
    SELECT a.id
    FROM alerts a
    JOIN resident_assignments ra
      ON ra.facility_id = a.facility_id
     AND ra.resident_id = a.resident_id
     AND ra.started_at <= a.detected_at
     AND (ra.ended_at > a.detected_at OR ra.ended_at IS NULL)
    WHERE a.space_id IS NULL
    GROUP BY a.id
    HAVING count(*) > 1
  ) ambiguous;

  IF unresolved_count <> 0 THEN
    RAISE EXCEPTION 'alert_space_expand blocked: % alert(s) unresolved after verified camera and temporal assignment backfill (missing_assignment=%, multiple_assignment=%). Current-active assignment fallback is forbidden; remediate historical resident assignments or camera mappings.', unresolved_count, missing_assignment_count, multiple_assignment_count;
  END IF;
END $$;

ALTER TABLE alerts
  ADD CONSTRAINT alerts_facility_id_space_id_fkey
  FOREIGN KEY (facility_id, space_id)
  REFERENCES spaces(facility_id, id)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;

CREATE INDEX alerts_facility_id_space_id_alert_seq_idx ON alerts(facility_id, space_id, alert_seq);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON alerts TO fall_app;

COMMIT;
