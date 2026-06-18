-- Data-preserving migration from the original Prisma camelCase table/column
-- names to the snake_case database names declared by @map/@@map.
-- Only ALTER ... RENAME operations are used for existing database objects.

-- ─── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE "Organization" RENAME COLUMN "businessRegistrationNumber" TO "business_registration_number";
ALTER TABLE "Organization" RENAME COLUMN "createdAt" TO "created_at";

ALTER TABLE "User" RENAME COLUMN "orgId" TO "org_id";
ALTER TABLE "User" RENAME COLUMN "kakaoId" TO "kakao_id";
ALTER TABLE "User" RENAME COLUMN "sessionVersion" TO "session_version";
ALTER TABLE "User" RENAME COLUMN "createdAt" TO "created_at";

ALTER TABLE "KakaoIdentity" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "KakaoIdentity" RENAME COLUMN "orgId" TO "org_id";
ALTER TABLE "KakaoIdentity" RENAME COLUMN "kakaoId" TO "kakao_id";
ALTER TABLE "KakaoIdentity" RENAME COLUMN "accessTokenCipher" TO "access_token_cipher";
ALTER TABLE "KakaoIdentity" RENAME COLUMN "tokenScope" TO "token_scope";
ALTER TABLE "KakaoIdentity" RENAME COLUMN "tokenExpiresAt" TO "token_expires_at";
ALTER TABLE "KakaoIdentity" RENAME COLUMN "createdAt" TO "created_at";

ALTER TABLE "ServerSession" RENAME COLUMN "userId" TO "user_id";
ALTER TABLE "ServerSession" RENAME COLUMN "orgId" TO "org_id";
ALTER TABLE "ServerSession" RENAME COLUMN "expiresAt" TO "expires_at";
ALTER TABLE "ServerSession" RENAME COLUMN "revokedAt" TO "revoked_at";
ALTER TABLE "ServerSession" RENAME COLUMN "createdAt" TO "created_at";

ALTER TABLE "Resident" RENAME COLUMN "orgId" TO "org_id";
ALTER TABLE "Resident" RENAME COLUMN "createdAt" TO "created_at";

ALTER TABLE "Guardian" RENAME COLUMN "orgId" TO "org_id";
ALTER TABLE "Guardian" RENAME COLUMN "residentId" TO "resident_id";
ALTER TABLE "Guardian" RENAME COLUMN "createdAt" TO "created_at";

ALTER TABLE "Camera" RENAME COLUMN "orgId" TO "org_id";
ALTER TABLE "Camera" RENAME COLUMN "residentId" TO "resident_id";
ALTER TABLE "Camera" RENAME COLUMN "ingestKeyId" TO "ingest_key_id";
ALTER TABLE "Camera" RENAME COLUMN "ingestSecretHash" TO "ingest_secret_hash";
ALTER TABLE "Camera" RENAME COLUMN "lastSeenAt" TO "last_seen_at";
ALTER TABLE "Camera" RENAME COLUMN "createdAt" TO "created_at";

ALTER TABLE "Alert" RENAME COLUMN "alertSeq" TO "alert_seq";
ALTER TABLE "Alert" RENAME COLUMN "orgId" TO "org_id";
ALTER TABLE "Alert" RENAME COLUMN "residentId" TO "resident_id";
ALTER TABLE "Alert" RENAME COLUMN "cameraId" TO "camera_id";
ALTER TABLE "Alert" RENAME COLUMN "snapshotKey" TO "snapshot_key";
ALTER TABLE "Alert" RENAME COLUMN "detectedAt" TO "detected_at";
ALTER TABLE "Alert" RENAME COLUMN "idempotencyKey" TO "idempotency_key";
ALTER TABLE "Alert" RENAME COLUMN "createdAt" TO "created_at";

ALTER TABLE "ResidentStatus" RENAME COLUMN "residentId" TO "resident_id";
ALTER TABLE "ResidentStatus" RENAME COLUMN "orgId" TO "org_id";
ALTER TABLE "ResidentStatus" RENAME COLUMN "lastSeenAt" TO "last_seen_at";
ALTER TABLE "ResidentStatus" RENAME COLUMN "cameraOnline" TO "camera_online";
ALTER TABLE "ResidentStatus" RENAME COLUMN "sourceId" TO "source_id";
ALTER TABLE "ResidentStatus" RENAME COLUMN "updatedAt" TO "updated_at";

-- ─── Indexes and sequences ──────────────────────────────────────────────────
ALTER INDEX "User_kakaoId_key" RENAME TO "users_kakao_id_key";
ALTER INDEX "KakaoIdentity_userId_key" RENAME TO "kakao_identities_user_id_key";
ALTER INDEX "Resident_orgId_id_key" RENAME TO "residents_org_id_id_key";
ALTER INDEX "Camera_orgId_id_key" RENAME TO "cameras_org_id_id_key";
ALTER INDEX "Camera_orgId_label_key" RENAME TO "cameras_org_id_label_key";
ALTER INDEX "Camera_orgId_ingestKeyId_key" RENAME TO "cameras_org_id_ingest_key_id_key";
ALTER INDEX "Alert_orgId_alertSeq_idx" RENAME TO "alerts_org_id_alert_seq_idx";
ALTER INDEX "Alert_orgId_idempotencyKey_key" RENAME TO "alerts_org_id_idempotency_key_key";
ALTER INDEX "ResidentStatus_residentId_key" RENAME TO "resident_statuses_resident_id_key";
ALTER INDEX "ResidentStatus_orgId_residentId_key" RENAME TO "resident_statuses_org_id_resident_id_key";
ALTER INDEX "alert_events_source_id_external_event_id_key" RENAME TO "alert_events_source_external_event_id_key";
ALTER SEQUENCE "Alert_alertSeq_seq" RENAME TO "alerts_alert_seq_seq";

-- ─── Constraints ────────────────────────────────────────────────────────────
ALTER TABLE "Organization" RENAME CONSTRAINT "Organization_pkey" TO "organizations_pkey";

ALTER TABLE "User" RENAME CONSTRAINT "User_pkey" TO "users_pkey";
ALTER TABLE "User" RENAME CONSTRAINT "User_orgId_fkey" TO "users_org_id_fkey";

ALTER TABLE "KakaoIdentity" RENAME CONSTRAINT "KakaoIdentity_pkey" TO "kakao_identities_pkey";
ALTER TABLE "KakaoIdentity" RENAME CONSTRAINT "KakaoIdentity_userId_fkey" TO "kakao_identities_user_id_fkey";
ALTER TABLE "KakaoIdentity" RENAME CONSTRAINT "KakaoIdentity_orgId_fkey" TO "kakao_identities_org_id_fkey";

ALTER TABLE "ServerSession" RENAME CONSTRAINT "ServerSession_pkey" TO "server_sessions_pkey";
ALTER TABLE "ServerSession" RENAME CONSTRAINT "ServerSession_userId_fkey" TO "server_sessions_user_id_fkey";
ALTER TABLE "ServerSession" RENAME CONSTRAINT "ServerSession_orgId_fkey" TO "server_sessions_org_id_fkey";

ALTER TABLE "Resident" RENAME CONSTRAINT "Resident_pkey" TO "residents_pkey";
ALTER TABLE "Resident" RENAME CONSTRAINT "Resident_orgId_fkey" TO "residents_org_id_fkey";

ALTER TABLE "Guardian" RENAME CONSTRAINT "Guardian_pkey" TO "guardians_pkey";
ALTER TABLE "Guardian" RENAME CONSTRAINT "Guardian_orgId_fkey" TO "guardians_org_id_fkey";
ALTER TABLE "Guardian" RENAME CONSTRAINT "Guardian_orgId_residentId_fkey" TO "guardians_org_id_resident_id_fkey";

ALTER TABLE "Camera" RENAME CONSTRAINT "Camera_pkey" TO "cameras_pkey";
ALTER TABLE "Camera" RENAME CONSTRAINT "Camera_orgId_fkey" TO "cameras_org_id_fkey";
ALTER TABLE "Camera" RENAME CONSTRAINT "Camera_orgId_residentId_fkey" TO "cameras_org_id_resident_id_fkey";

ALTER TABLE "Alert" RENAME CONSTRAINT "Alert_pkey" TO "alerts_pkey";
ALTER TABLE "Alert" RENAME CONSTRAINT "Alert_orgId_fkey" TO "alerts_org_id_fkey";
ALTER TABLE "Alert" RENAME CONSTRAINT "Alert_orgId_residentId_fkey" TO "alerts_org_id_resident_id_fkey";
ALTER TABLE "Alert" RENAME CONSTRAINT "Alert_orgId_cameraId_fkey" TO "alerts_org_id_camera_id_fkey";

ALTER TABLE "ResidentStatus" RENAME CONSTRAINT "ResidentStatus_pkey" TO "resident_statuses_pkey";
ALTER TABLE "ResidentStatus" RENAME CONSTRAINT "ResidentStatus_orgId_fkey" TO "resident_statuses_org_id_fkey";
ALTER TABLE "ResidentStatus" RENAME CONSTRAINT "ResidentStatus_orgId_residentId_fkey" TO "resident_statuses_org_id_resident_id_fkey";
ALTER TABLE "ResidentStatus" RENAME CONSTRAINT "ResidentStatus_orgId_sourceId_fkey" TO "resident_statuses_org_id_source_id_fkey";

-- ─── Tables ─────────────────────────────────────────────────────────────────
ALTER TABLE "Organization" RENAME TO "organizations";
ALTER TABLE "User" RENAME TO "users";
ALTER TABLE "KakaoIdentity" RENAME TO "kakao_identities";
ALTER TABLE "ServerSession" RENAME TO "server_sessions";
ALTER TABLE "Resident" RENAME TO "residents";
ALTER TABLE "Guardian" RENAME TO "guardians";
ALTER TABLE "Camera" RENAME TO "cameras";
ALTER TABLE "Alert" RENAME TO "alerts";
ALTER TABLE "ResidentStatus" RENAME TO "resident_statuses";

-- ─── SECURITY DEFINER lookup function ───────────────────────────────────────
-- get_camera_for_ingest's body is stored as text and does NOT auto-update on
-- table/column rename. Recreate it to read the snake_case columns while keeping
-- the camelCase OUTPUT column names the ingest HMAC guard ($queryRaw) consumes.
CREATE OR REPLACE FUNCTION get_camera_for_ingest(p_key_id TEXT)
RETURNS TABLE(
  id TEXT,
  "orgId" TEXT,
  "residentId" TEXT,
  "ingestKeyId" TEXT,
  "ingestSecretHash" TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id,
         org_id AS "orgId",
         resident_id AS "residentId",
         ingest_key_id AS "ingestKeyId",
         ingest_secret_hash AS "ingestSecretHash"
  FROM cameras
  WHERE ingest_key_id = p_key_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_camera_for_ingest(TEXT) TO fall_app;
