-- Create immutable tenant-scoped ML event SSOT.
CREATE TABLE events (
    id TEXT NOT NULL,
    facility_id TEXT NOT NULL,
    camera_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    type TEXT NOT NULL,
    confidence DOUBLE PRECISION,
    detected_at TIMESTAMP(3) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMP(3) NOT NULL,
    dedup_key TEXT NOT NULL,

    CONSTRAINT events_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX events_facility_id_id_key ON events(facility_id, id);
CREATE UNIQUE INDEX events_facility_id_dedup_key_key ON events(facility_id, dedup_key);
CREATE INDEX events_facility_id_detected_at_idx ON events(facility_id, detected_at);
CREATE INDEX events_facility_id_camera_id_detected_at_idx ON events(facility_id, camera_id, detected_at);

ALTER TABLE events ADD CONSTRAINT events_facility_id_fkey
    FOREIGN KEY (facility_id) REFERENCES facilities(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE events ADD CONSTRAINT events_facility_id_camera_id_fkey
    FOREIGN KEY (facility_id, camera_id) REFERENCES cameras(facility_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE events ADD CONSTRAINT events_facility_id_space_id_fkey
    FOREIGN KEY (facility_id, space_id) REFERENCES spaces(facility_id, id) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON events
  USING     (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

REVOKE ALL ON events FROM PUBLIC;
REVOKE UPDATE, DELETE ON events FROM fall_app;
GRANT SELECT, INSERT ON events TO fall_app;
