BEGIN;

DO $$
DECLARE
  null_alerts integer;
BEGIN
  SELECT COUNT(*) INTO null_alerts FROM alerts WHERE space_id IS NULL;

  IF null_alerts <> 0 THEN
    RAISE EXCEPTION 'Cannot set alerts.space_id NOT NULL: % alerts have NULL space_id', null_alerts;
  END IF;
END $$;

ALTER TABLE alerts
  ALTER COLUMN space_id SET NOT NULL;

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON alerts TO fall_app;

COMMIT;
