-- Add stable edge identity while preserving the legacy events.clip_id rollback seam.
CREATE TYPE "MediaClipStatus" AS ENUM (
    'PENDING',
    'READY',
    'UNAVAILABLE',
    'EXPIRED',
    'DELETED'
);

CREATE TYPE "MediaStorageState" AS ENUM (
    'NONE',
    'STAGED',
    'READY',
    'DELETING',
    'DELETED'
);

CREATE TYPE "MediaClipReason" AS ENUM (
    'CAPTURE_FAILED',
    'QUEUE_FULL',
    'CORRUPT',
    'LEGACY_MISSING',
    'UPLOAD_TIMEOUT',
    'STORAGE_MISSING',
    'RETENTION_EXPIRED',
    'ADMIN_DELETED',
    'LEGAL_ERASURE'
);

CREATE TYPE "MediaHoldKind" AS ENUM (
    'LEGAL',
    'ACCESS_REQUEST',
    'INCIDENT'
);

CREATE TYPE "MediaAccessAction" AS ENUM (
    'METADATA_READ',
    'CONTENT_GRANTED',
    'CONTENT_COMPLETED',
    'CONTENT_ABORTED',
    'PLAY_STARTED',
    'FULLSCREEN_ENTERED'
);

CREATE TYPE "MediaAccessOutcome" AS ENUM (
    'ALLOWED',
    'DENIED',
    'NOT_FOUND',
    'NOT_READY',
    'FAILED'
);

ALTER TABLE events ADD COLUMN edge_event_id UUID;
ALTER TABLE events ADD CONSTRAINT events_edge_event_id_v4_check
    CHECK (edge_event_id IS NULL OR edge_event_id::text ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

CREATE UNIQUE INDEX events_facility_id_edge_event_id_key
    ON events(facility_id, edge_event_id);

CREATE TABLE media_clips (
    id TEXT NOT NULL,
    facility_id TEXT NOT NULL,
    camera_id TEXT NOT NULL,
    external_clip_id VARCHAR(200) NOT NULL,
    status "MediaClipStatus" NOT NULL DEFAULT 'PENDING',
    state_version INTEGER NOT NULL DEFAULT 1,
    reason "MediaClipReason",
    storage_state "MediaStorageState" NOT NULL DEFAULT 'NONE',
    storage_key TEXT,
    content_type TEXT,
    byte_size BIGINT,
    sha256 CHAR(64),
    codec VARCHAR(32),
    duration_ms INTEGER,
    finalized_at TIMESTAMP(3),
    clip_start_at TIMESTAMP(3),
    clip_end_at TIMESTAMP(3),
    staged_at TIMESTAMP(3),
    ready_at TIMESTAMP(3),
    expires_at TIMESTAMP(3),
    expired_at TIMESTAMP(3),
    deleted_at TIMESTAMP(3),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP(3) NOT NULL,

    CONSTRAINT media_clips_pkey PRIMARY KEY (id),
    CONSTRAINT media_clips_state_version_check CHECK (state_version >= 1),
    CONSTRAINT media_clips_external_clip_id_check
        CHECK (external_clip_id ~ '^[A-Za-z0-9._-]{1,200}$'),
    CONSTRAINT media_clips_sha256_check
        CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT media_clips_byte_size_check
        CHECK (byte_size IS NULL OR byte_size > 0),
    CONSTRAINT media_clips_duration_ms_check
        CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 120000),
    CONSTRAINT media_clips_capture_interval_check
        CHECK (clip_start_at IS NULL OR clip_end_at IS NULL OR clip_start_at <= clip_end_at),
    CONSTRAINT media_clips_finalized_after_capture_check
        CHECK (clip_end_at IS NULL OR finalized_at IS NULL OR clip_end_at <= finalized_at),
    CONSTRAINT media_clips_ready_integrity_check
        CHECK (status <> 'READY' OR
          (storage_state = 'READY' AND storage_key IS NOT NULL
           AND content_type = 'video/mp4' AND byte_size IS NOT NULL
           AND sha256 IS NOT NULL AND ready_at IS NOT NULL))
);

CREATE UNIQUE INDEX media_clips_facility_id_id_key
    ON media_clips(facility_id, id);
CREATE UNIQUE INDEX media_clips_facility_id_external_clip_id_key
    ON media_clips(facility_id, external_clip_id);
CREATE UNIQUE INDEX media_clips_storage_key_key
    ON media_clips(storage_key);
CREATE INDEX media_clips_facility_id_status_expires_at_idx
    ON media_clips(facility_id, status, expires_at);
CREATE INDEX media_clips_facility_id_storage_state_staged_at_idx
    ON media_clips(facility_id, storage_state, staged_at);

CREATE TABLE event_media_bindings (
    event_id TEXT NOT NULL,
    facility_id TEXT NOT NULL,
    clip_id TEXT NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT event_media_bindings_pkey PRIMARY KEY (event_id)
);

CREATE UNIQUE INDEX event_media_bindings_facility_id_event_id_key
    ON event_media_bindings(facility_id, event_id);
CREATE INDEX event_media_bindings_facility_id_clip_id_idx
    ON event_media_bindings(facility_id, clip_id);

CREATE TABLE media_retention_holds (
    id TEXT NOT NULL,
    facility_id TEXT NOT NULL,
    clip_id TEXT NOT NULL,
    kind "MediaHoldKind" NOT NULL,
    reason VARCHAR(500) NOT NULL,
    created_by_user_id TEXT,
    released_by_user_id TEXT,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TIMESTAMP(3),

    CONSTRAINT media_retention_holds_pkey PRIMARY KEY (id)
);

CREATE INDEX media_retention_holds_facility_id_clip_id_released_at_idx
    ON media_retention_holds(facility_id, clip_id, released_at);

CREATE TABLE media_access_logs (
    id BIGSERIAL NOT NULL,
    facility_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_role "Role" NOT NULL,
    clip_id TEXT,
    alert_id TEXT,
    target_alert_hash CHAR(64) NOT NULL,
    action "MediaAccessAction" NOT NULL,
    outcome "MediaAccessOutcome" NOT NULL,
    http_status INTEGER NOT NULL,
    request_id VARCHAR(64) NOT NULL,
    interaction_id VARCHAR(64),
    range_start BIGINT,
    range_end BIGINT,
    bytes_planned BIGINT,
    bytes_actual BIGINT,
    ip_hash CHAR(64),
    user_agent VARCHAR(512),
    occurred_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT media_access_logs_pkey PRIMARY KEY (id),
    CONSTRAINT media_access_logs_target_alert_hash_check
        CHECK (target_alert_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT media_access_logs_ip_hash_check
        CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT media_access_logs_http_status_check
        CHECK (http_status BETWEEN 100 AND 599),
    CONSTRAINT media_access_logs_range_check
        CHECK (range_start IS NULL OR range_end IS NULL OR
               (range_start >= 0 AND range_end >= range_start)),
    CONSTRAINT media_access_logs_bytes_planned_check
        CHECK (bytes_planned IS NULL OR bytes_planned >= 0),
    CONSTRAINT media_access_logs_bytes_actual_check
        CHECK (bytes_actual IS NULL OR bytes_actual >= 0)
);

CREATE UNIQUE INDEX media_access_logs_actor_user_id_interaction_id_key
    ON media_access_logs(actor_user_id, interaction_id);
CREATE INDEX media_access_logs_facility_id_occurred_at_idx
    ON media_access_logs(facility_id, occurred_at);
CREATE INDEX media_access_logs_facility_id_clip_id_occurred_at_idx
    ON media_access_logs(facility_id, clip_id, occurred_at);
CREATE INDEX media_access_logs_request_id_idx
    ON media_access_logs(request_id);

ALTER TABLE media_clips ADD CONSTRAINT media_clips_facility_id_fkey
    FOREIGN KEY (facility_id) REFERENCES facilities(id)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE media_clips ADD CONSTRAINT media_clips_facility_id_camera_id_fkey
    FOREIGN KEY (facility_id, camera_id) REFERENCES cameras(facility_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE event_media_bindings
    ADD CONSTRAINT event_media_bindings_facility_id_event_id_fkey
    FOREIGN KEY (facility_id, event_id) REFERENCES events(facility_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE event_media_bindings
    ADD CONSTRAINT event_media_bindings_facility_id_clip_id_fkey
    FOREIGN KEY (facility_id, clip_id) REFERENCES media_clips(facility_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE media_retention_holds
    ADD CONSTRAINT media_retention_holds_facility_id_clip_id_fkey
    FOREIGN KEY (facility_id, clip_id) REFERENCES media_clips(facility_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Refuse a lossy backfill. Invalid identifiers stay in events.clip_id and are reported.
DO $$
DECLARE
    invalid_count BIGINT;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM events
        WHERE clip_id IS NOT NULL AND btrim(clip_id) <> ''
        GROUP BY facility_id, clip_id
        HAVING count(DISTINCT camera_id) > 1
    ) THEN
        RAISE EXCEPTION 'legacy clip_id maps to multiple cameras in one facility';
    END IF;

    SELECT count(*) INTO invalid_count
    FROM events
    WHERE clip_id IS NOT NULL
      AND clip_id !~ '^[A-Za-z0-9._-]{1,200}$';

    IF invalid_count > 0 THEN
        RAISE NOTICE 'legacy clip_id left unbound: % row(s)', invalid_count;
    END IF;
END $$;

INSERT INTO media_clips (
    id,
    facility_id,
    camera_id,
    external_clip_id,
    status,
    state_version,
    storage_state,
    created_at,
    updated_at
)
SELECT DISTINCT
    'legacy_' || md5(facility_id || ':' || clip_id),
    facility_id,
    camera_id,
    clip_id,
    'PENDING'::"MediaClipStatus",
    1,
    'NONE'::"MediaStorageState",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM events
WHERE clip_id ~ '^[A-Za-z0-9._-]{1,200}$';

INSERT INTO event_media_bindings (event_id, facility_id, clip_id, created_at)
SELECT
    id,
    facility_id,
    'legacy_' || md5(facility_id || ':' || clip_id),
    CURRENT_TIMESTAMP
FROM events
WHERE clip_id ~ '^[A-Za-z0-9._-]{1,200}$';

-- Every media table is facility-scoped in both the app guard and PostgreSQL.
ALTER TABLE media_clips ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_clips FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_clips
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

ALTER TABLE event_media_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_media_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_media_bindings
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

ALTER TABLE media_retention_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_retention_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_retention_holds
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

ALTER TABLE media_access_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_access_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_access_logs
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

REVOKE ALL ON media_clips, event_media_bindings, media_retention_holds, media_access_logs FROM PUBLIC;
REVOKE ALL ON SEQUENCE media_access_logs_id_seq FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON media_clips, event_media_bindings, media_retention_holds TO fall_app;
REVOKE DELETE ON media_clips, event_media_bindings, media_retention_holds FROM fall_app;

GRANT SELECT, INSERT ON media_access_logs TO fall_app;
REVOKE UPDATE, DELETE ON media_access_logs FROM fall_app;
GRANT USAGE, SELECT ON SEQUENCE media_access_logs_id_seq TO fall_app;
