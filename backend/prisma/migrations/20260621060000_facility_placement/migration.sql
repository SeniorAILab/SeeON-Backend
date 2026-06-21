-- Facility placement domain: facility metadata + floors/spaces/zones.

ALTER TABLE facilities
  ADD COLUMN code TEXT,
  ADD COLUMN address TEXT,
  ADD COLUMN phone TEXT;

-- Deterministic collision-safe slug backfill. Prefer a slug from the facility
-- name only when that normalized name is unique; duplicate slugs fall back to
-- the stable facility id so the unique index can be created safely.
WITH normalized AS (
  SELECT
    id,
    COALESCE(
      NULLIF(
        regexp_replace(
          regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'),
          '(^-|-$)',
          '',
          'g'
        ),
        ''
      ),
      id
    ) AS base_code
  FROM facilities
), counted AS (
  SELECT id, base_code, COUNT(*) OVER (PARTITION BY base_code) AS base_count
  FROM normalized
)
UPDATE facilities f
SET code = CASE
  WHEN c.base_count = 1 THEN c.base_code
  ELSE f.id
END
FROM counted c
WHERE f.id = c.id;

ALTER TABLE facilities ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX facilities_code_key ON facilities(code);

CREATE TYPE "SpaceType" AS ENUM (
  'ROOM',
  'HALLWAY',
  'PROGRAM_ROOM',
  'REHAB_ROOM',
  'DINING',
  'LOBBY',
  'OFFICE',
  'NURSE_STATION',
  'ENTRANCE',
  'STORAGE',
  'STAFF_LOUNGE',
  'ETC'
);

CREATE TYPE "ZoneType" AS ENUM ('BED', 'AREA');

CREATE TABLE floors (
  id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  name TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT floors_pkey PRIMARY KEY (id)
);

CREATE TABLE spaces (
  id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  floor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type "SpaceType" NOT NULL,
  capacity INTEGER NOT NULL,
  camera_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  assigned_staff TEXT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT spaces_pkey PRIMARY KEY (id)
);

CREATE TABLE zones (
  id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type "ZoneType" NOT NULL,
  order_index INTEGER NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT zones_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX floors_facility_id_name_key ON floors(facility_id, name);
CREATE UNIQUE INDEX floors_facility_id_id_key ON floors(facility_id, id);

CREATE UNIQUE INDEX spaces_facility_id_floor_id_name_key ON spaces(facility_id, floor_id, name);
CREATE UNIQUE INDEX spaces_facility_id_id_key ON spaces(facility_id, id);

CREATE UNIQUE INDEX zones_facility_id_space_id_name_key ON zones(facility_id, space_id, name);
CREATE UNIQUE INDEX zones_facility_id_id_key ON zones(facility_id, id);

ALTER TABLE floors ADD CONSTRAINT floors_facility_id_fkey
  FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE spaces ADD CONSTRAINT spaces_facility_id_fkey
  FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE spaces ADD CONSTRAINT spaces_facility_id_floor_id_fkey
  FOREIGN KEY (facility_id, floor_id) REFERENCES floors(facility_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE zones ADD CONSTRAINT zones_facility_id_fkey
  FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE zones ADD CONSTRAINT zones_facility_id_space_id_fkey
  FOREIGN KEY (facility_id, space_id) REFERENCES spaces(facility_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE floors ENABLE ROW LEVEL SECURITY;
ALTER TABLE floors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON floors
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
GRANT SELECT,INSERT,UPDATE,DELETE ON floors TO fall_app;

ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE spaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON spaces
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
GRANT SELECT,INSERT,UPDATE,DELETE ON spaces TO fall_app;

ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE zones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON zones
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
GRANT SELECT,INSERT,UPDATE,DELETE ON zones TO fall_app;
