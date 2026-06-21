-- Residents soft-delete and placement assignment history.

CREATE TYPE "Level" AS ENUM ('LOW','MEDIUM','HIGH');

ALTER TABLE residents
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN gender TEXT,
  ADD COLUMN age INTEGER,
  ADD COLUMN diagnosis_tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN fall_risk_baseline "Level",
  ADD COLUMN is_focus_resident BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE resident_assignments (
  id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  resident_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  zone_id TEXT,
  started_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT resident_assignments_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX resident_assignments_facility_id_id_key ON resident_assignments(facility_id, id);
CREATE INDEX resident_assignments_facility_id_resident_id_idx ON resident_assignments(facility_id, resident_id);
CREATE UNIQUE INDEX resident_assignments_active_resident_key ON resident_assignments (resident_id) WHERE ended_at IS NULL;

ALTER TABLE resident_assignments ADD CONSTRAINT resident_assignments_facility_id_fkey
  FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE resident_assignments ADD CONSTRAINT resident_assignments_facility_id_resident_id_fkey
  FOREIGN KEY (facility_id, resident_id) REFERENCES residents(facility_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE resident_assignments ADD CONSTRAINT resident_assignments_facility_id_space_id_fkey
  FOREIGN KEY (facility_id, space_id) REFERENCES spaces(facility_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE resident_assignments ADD CONSTRAINT resident_assignments_facility_id_zone_id_fkey
  FOREIGN KEY (facility_id, zone_id) REFERENCES zones(facility_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE resident_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE resident_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON resident_assignments
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
GRANT SELECT,INSERT,UPDATE,DELETE ON resident_assignments TO fall_app;

-- Backfill rule: legacy Resident.room is mapped to one active assignment per resident.
-- Prefer the exact single active space in the same facility with name = room; otherwise
-- create/reuse a deterministic "Legacy rooms" floor and room-named Space. Residents
-- that already have an active assignment are skipped so this block is idempotent.
DO $$
DECLARE
  legacy_floor_id TEXT;
  chosen_space_id TEXT;
  active_named_space_count INTEGER;
  resident_row RECORD;
BEGIN
  FOR resident_row IN
    SELECT r.id, r.facility_id, r.room
    FROM residents r
    WHERE r.room IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM resident_assignments ra
        WHERE ra.resident_id = r.id AND ra.ended_at IS NULL
      )
    ORDER BY r.facility_id, r.id
  LOOP
    SELECT f.id INTO legacy_floor_id
    FROM floors f
    WHERE f.facility_id = resident_row.facility_id AND f.name = 'Legacy rooms'
    ORDER BY f.id
    LIMIT 1;

    IF legacy_floor_id IS NULL THEN
      legacy_floor_id := md5(resident_row.facility_id || ':legacy-rooms-floor');
      INSERT INTO floors (id, facility_id, name, order_index)
      VALUES (
        legacy_floor_id,
        resident_row.facility_id,
        'Legacy rooms',
        COALESCE((SELECT MAX(order_index) + 1 FROM floors WHERE facility_id = resident_row.facility_id), 1)
      )
      ON CONFLICT (facility_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id INTO legacy_floor_id;
    END IF;

    SELECT COUNT(*)::int INTO active_named_space_count
    FROM spaces s
    WHERE s.facility_id = resident_row.facility_id
      AND s.name = resident_row.room
      AND s.is_active = true;

    IF active_named_space_count = 1 THEN
      SELECT s.id INTO chosen_space_id
      FROM spaces s
      WHERE s.facility_id = resident_row.facility_id
        AND s.name = resident_row.room
        AND s.is_active = true
      LIMIT 1;
    ELSE
      chosen_space_id := md5(resident_row.facility_id || ':legacy-space:' || resident_row.room);
      INSERT INTO spaces (id, facility_id, floor_id, name, type, capacity)
      VALUES (chosen_space_id, resident_row.facility_id, legacy_floor_id, resident_row.room, 'ROOM', 1)
      ON CONFLICT (facility_id, floor_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id INTO chosen_space_id;
    END IF;

    INSERT INTO resident_assignments (id, facility_id, resident_id, space_id, started_at)
    VALUES (
      md5(resident_row.facility_id || ':' || resident_row.id || ':legacy-assignment'),
      resident_row.facility_id,
      resident_row.id,
      chosen_space_id,
      now()
    )
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
