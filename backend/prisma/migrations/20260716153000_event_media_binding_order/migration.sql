-- Preserve producer event_refs order as part of immutable clip identity.
ALTER TABLE media_clips ADD COLUMN staging_token CHAR(64);
ALTER TABLE media_clips
    ADD CONSTRAINT media_clips_staging_token_check
    CHECK (staging_token IS NULL OR staging_token ~ '^[0-9a-f]{64}$');

ALTER TABLE event_media_bindings ADD COLUMN ordinal INTEGER;

WITH ranked_bindings AS (
    SELECT
        event_id,
        (row_number() OVER (
            PARTITION BY facility_id, clip_id
            ORDER BY created_at, event_id
        ) - 1)::INTEGER AS ordinal
    FROM event_media_bindings
)
UPDATE event_media_bindings AS binding
SET ordinal = ranked.ordinal
FROM ranked_bindings AS ranked
WHERE ranked.event_id = binding.event_id;

ALTER TABLE event_media_bindings
    ALTER COLUMN ordinal SET NOT NULL;
ALTER TABLE event_media_bindings
    ADD CONSTRAINT event_media_bindings_ordinal_check
    CHECK (ordinal >= 0);

CREATE UNIQUE INDEX event_media_bindings_facility_id_clip_id_ordinal_key
    ON event_media_bindings(facility_id, clip_id, ordinal);
