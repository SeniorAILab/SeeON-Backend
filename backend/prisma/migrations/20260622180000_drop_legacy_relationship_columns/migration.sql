BEGIN;

DO $$
DECLARE
  null_camera_space_count integer;
  null_alert_space_count integer;
  unresolved_space_camera_count integer;
BEGIN
  SELECT COUNT(*) INTO null_camera_space_count FROM cameras WHERE space_id IS NULL;
  SELECT COUNT(*) INTO null_alert_space_count FROM alerts WHERE space_id IS NULL;

  SELECT COUNT(*) INTO unresolved_space_camera_count
  FROM spaces s
  WHERE s.camera_id IS NOT NULL
    AND (
      NOT EXISTS (SELECT 1 FROM cameras c WHERE c.id = s.camera_id)
      OR EXISTS (SELECT 1 FROM cameras c WHERE c.id = s.camera_id AND c.facility_id <> s.facility_id)
      OR EXISTS (
        SELECT 1
        FROM cameras c
        WHERE c.id = s.camera_id
          AND (c.facility_id <> s.facility_id OR c.space_id <> s.id)
      )
      OR EXISTS (
        SELECT 1
        FROM spaces duplicate_space
        WHERE duplicate_space.facility_id = s.facility_id
          AND duplicate_space.camera_id = s.camera_id
          AND duplicate_space.id <> s.id
      )
    );

  IF null_camera_space_count <> 0 THEN
    RAISE EXCEPTION 'drop_legacy_relationship_columns blocked: cameras.space_id contains % NULL row(s).', null_camera_space_count;
  END IF;

  IF null_alert_space_count <> 0 THEN
    RAISE EXCEPTION 'drop_legacy_relationship_columns blocked: alerts.space_id contains % NULL row(s).', null_alert_space_count;
  END IF;

  IF unresolved_space_camera_count <> 0 THEN
    RAISE EXCEPTION 'drop_legacy_relationship_columns blocked: spaces.camera_id contains % unresolved stale/cross-facility/duplicate/mismatched claim(s).', unresolved_space_camera_count;
  END IF;
END $$;

ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_facility_id_resident_id_fkey;
ALTER TABLE cameras DROP COLUMN IF EXISTS resident_id;
ALTER TABLE residents DROP COLUMN IF EXISTS room;
ALTER TABLE spaces DROP COLUMN IF EXISTS camera_id;

ALTER TABLE cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE cameras FORCE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts FORCE ROW LEVEL SECURITY;
ALTER TABLE residents ENABLE ROW LEVEL SECURITY;
ALTER TABLE residents FORCE ROW LEVEL SECURITY;
ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE spaces FORCE ROW LEVEL SECURITY;
ALTER TABLE resident_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE resident_assignments FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON cameras TO fall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON alerts TO fall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON residents TO fall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON spaces TO fall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON resident_assignments TO fall_app;

COMMIT;
