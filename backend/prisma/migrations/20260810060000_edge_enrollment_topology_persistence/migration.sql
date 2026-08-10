-- CreateEnum
CREATE TYPE "EdgeCredentialLifecycle" AS ENUM ('ACTIVE', 'GRACE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EdgeInstallationState" AS ENUM ('PENDING_CLAIM', 'CLAIMED', 'REPLACED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "EdgeOperationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EdgeTopologySnapshotStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EdgeOmissionPreviewStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXPIRED', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "EdgeTopologyEntityKind" AS ENUM ('FLOOR', 'ROOM', 'CAMERA');

-- CreateEnum
CREATE TYPE "ProvisioningSource" AS ENUM ('PRODUCT', 'EDGE');

-- CreateEnum
CREATE TYPE "EdgeValidationGrantStatus" AS ENUM ('ACTIVE', 'CLOSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MediaDownloadAuditState" AS ENUM ('STARTED', 'COMPLETED', 'ABORTED');

-- CreateEnum
CREATE TYPE "MediaDownloadOutboxState" AS ENUM ('PENDING', 'COMPLETED');

-- AlterTable
ALTER TABLE "cameras" ADD COLUMN     "edge_installation_id" UUID,
ADD COLUMN     "edge_ref" VARCHAR(64),
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "provisioning_source" "ProvisioningSource" NOT NULL DEFAULT 'PRODUCT';

-- AlterTable
ALTER TABLE "facilities" ADD COLUMN     "edge_code" VARCHAR(13),
ADD COLUMN     "topology_revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "floors" ADD COLUMN     "edge_installation_id" UUID,
ADD COLUMN     "edge_ref" VARCHAR(64),
ADD COLUMN     "provisioning_source" "ProvisioningSource" NOT NULL DEFAULT 'PRODUCT';

-- AlterTable
ALTER TABLE "spaces" ADD COLUMN     "edge_installation_id" UUID,
ADD COLUMN     "edge_ref" VARCHAR(64),
ADD COLUMN     "provisioning_source" "ProvisioningSource" NOT NULL DEFAULT 'PRODUCT';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "managed_identity_key" TEXT;

-- CreateTable
CREATE TABLE "edge_installations" (
    "id" UUID NOT NULL,
    "facility_id" TEXT NOT NULL,
    "current_generation" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deactivated_at" TIMESTAMP(3),

    CONSTRAINT "edge_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_installation_generations" (
    "id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "edge_installation_id" UUID NOT NULL,
    "enrollment_generation" INTEGER NOT NULL,
    "state" "EdgeInstallationState" NOT NULL DEFAULT 'PENDING_CLAIM',
    "client_installation_ref" UUID,
    "accepted_client_revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "replaced_at" TIMESTAMP(3),
    "deactivated_at" TIMESTAMP(3),

    CONSTRAINT "edge_installation_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_credentials" (
    "token_id" CHAR(12) NOT NULL,
    "facility_id" TEXT NOT NULL,
    "edge_installation_id" UUID NOT NULL,
    "enrollment_generation" INTEGER NOT NULL,
    "token_digest" CHAR(64) NOT NULL,
    "token_prefix" VARCHAR(64) NOT NULL,
    "lifecycle" "EdgeCredentialLifecycle" NOT NULL DEFAULT 'ACTIVE',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "grace_expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" VARCHAR(64),

    CONSTRAINT "edge_credentials_pkey" PRIMARY KEY ("token_id")
);

-- CreateTable
CREATE TABLE "edge_admin_operations" (
    "id" UUID NOT NULL,
    "facility_id" TEXT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "operation_type" VARCHAR(64) NOT NULL,
    "body_hash" CHAR(64) NOT NULL,
    "status" "EdgeOperationStatus" NOT NULL DEFAULT 'PENDING',
    "redacted_result" JSONB,
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "edge_admin_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_topology_snapshots" (
    "id" UUID NOT NULL,
    "facility_id" TEXT NOT NULL,
    "edge_installation_id" UUID NOT NULL,
    "enrollment_generation" INTEGER NOT NULL,
    "client_revision" INTEGER NOT NULL,
    "expected_server_revision" INTEGER NOT NULL,
    "server_revision" INTEGER,
    "body_hash" CHAR(64) NOT NULL,
    "canonical_body" JSONB NOT NULL,
    "status" "EdgeTopologySnapshotStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "edge_topology_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_omission_previews" (
    "confirmation_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "facility_id" TEXT NOT NULL,
    "edge_installation_id" UUID NOT NULL,
    "enrollment_generation" INTEGER NOT NULL,
    "server_revision" INTEGER NOT NULL,
    "digest" CHAR(64) NOT NULL,
    "omitted_floor_refs" JSONB NOT NULL,
    "omitted_room_refs" JSONB NOT NULL,
    "omitted_camera_refs" JSONB NOT NULL,
    "status" "EdgeOmissionPreviewStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "invalidated_at" TIMESTAMP(3),

    CONSTRAINT "edge_omission_previews_pkey" PRIMARY KEY ("confirmation_id")
);

-- CreateTable
CREATE TABLE "edge_topology_aliases" (
    "id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "edge_installation_id" UUID NOT NULL,
    "enrollment_generation" INTEGER NOT NULL,
    "kind" "EdgeTopologyEntityKind" NOT NULL,
    "edge_ref" VARCHAR(64) NOT NULL,
    "canonical_id" TEXT NOT NULL,
    "parent_canonical_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_topology_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_ownership_transfers" (
    "id" UUID NOT NULL,
    "facility_id" TEXT NOT NULL,
    "edge_installation_id" UUID NOT NULL,
    "enrollment_generation" INTEGER NOT NULL,
    "expected_server_revision" INTEGER NOT NULL,
    "manifest_digest" CHAR(64) NOT NULL,
    "manifest" JSONB NOT NULL,
    "status" "EdgeOperationStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "applied_server_revision" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "edge_ownership_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_validation_grants" (
    "id" UUID NOT NULL,
    "facility_id" TEXT NOT NULL,
    "edge_installation_id" UUID NOT NULL,
    "enrollment_generation" INTEGER NOT NULL,
    "status" "EdgeValidationGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "edge_validation_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_provisioning_audit_history" (
    "id" BIGSERIAL NOT NULL,
    "facility_id" TEXT NOT NULL,
    "edge_installation_id" UUID,
    "enrollment_generation" INTEGER,
    "actor_user_id" TEXT,
    "action" VARCHAR(64) NOT NULL,
    "outcome" VARCHAR(32) NOT NULL,
    "request_id" VARCHAR(64) NOT NULL,
    "operation_id" UUID,
    "detail" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_provisioning_audit_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_download_process_heartbeats" (
    "process_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "stopped_at" TIMESTAMP(3),

    CONSTRAINT "media_download_process_heartbeats_pkey" PRIMARY KEY ("process_id")
);

-- CreateTable
CREATE TABLE "media_download_audits" (
    "id" UUID NOT NULL,
    "facility_id" TEXT NOT NULL,
    "clip_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "actor_role" "Role" NOT NULL,
    "state" "MediaDownloadAuditState" NOT NULL DEFAULT 'STARTED',
    "request_id" VARCHAR(64) NOT NULL,
    "http_status" INTEGER NOT NULL,
    "range_start" BIGINT,
    "range_end" BIGINT,
    "bytes_planned" BIGINT,
    "bytes_actual" BIGINT,
    "process_id" UUID NOT NULL,
    "lease_version" INTEGER NOT NULL DEFAULT 1,
    "stream_lease_expires_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "aborted_at" TIMESTAMP(3),
    "abort_reason" VARCHAR(128),

    CONSTRAINT "media_download_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_download_outbox_jobs" (
    "audit_id" UUID NOT NULL,
    "facility_id" TEXT NOT NULL,
    "state" "MediaDownloadOutboxState" NOT NULL DEFAULT 'PENDING',
    "lease_version" INTEGER NOT NULL DEFAULT 1,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by_process_id" UUID,
    "locked_at" TIMESTAMP(3),
    "recovery_started_at" TIMESTAMP(3),
    "recovered_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_download_outbox_jobs_pkey" PRIMARY KEY ("audit_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "edge_installations_facility_id_id_key" ON "edge_installations"("facility_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "edge_installation_generations_facility_id_edge_installation_key" ON "edge_installation_generations"("facility_id", "edge_installation_id", "enrollment_generation");

-- CreateIndex
CREATE UNIQUE INDEX "edge_installation_generations_facility_id_client_installati_key" ON "edge_installation_generations"("facility_id", "client_installation_ref");

-- CreateIndex
CREATE UNIQUE INDEX "edge_credentials_token_digest_key" ON "edge_credentials"("token_digest");

-- CreateIndex
CREATE INDEX "edge_credentials_facility_id_lifecycle_expires_at_idx" ON "edge_credentials"("facility_id", "lifecycle", "expires_at");

-- CreateIndex
CREATE INDEX "edge_credentials_edge_installation_id_enrollment_generation_idx" ON "edge_credentials"("edge_installation_id", "enrollment_generation");

-- CreateIndex
CREATE UNIQUE INDEX "edge_admin_operations_idempotency_key_key" ON "edge_admin_operations"("idempotency_key");

-- CreateIndex
CREATE INDEX "edge_admin_operations_facility_id_created_at_idx" ON "edge_admin_operations"("facility_id", "created_at");

-- CreateIndex
CREATE INDEX "edge_topology_snapshots_facility_id_created_at_idx" ON "edge_topology_snapshots"("facility_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "edge_topology_snapshots_facility_id_id_key" ON "edge_topology_snapshots"("facility_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "edge_topology_snapshots_facility_id_edge_installation_id_en_key" ON "edge_topology_snapshots"("facility_id", "edge_installation_id", "enrollment_generation", "client_revision");

-- CreateIndex
CREATE UNIQUE INDEX "edge_omission_previews_snapshot_id_key" ON "edge_omission_previews"("snapshot_id");

-- CreateIndex
CREATE INDEX "edge_omission_previews_facility_id_status_expires_at_idx" ON "edge_omission_previews"("facility_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "edge_omission_previews_facility_id_confirmation_id_key" ON "edge_omission_previews"("facility_id", "confirmation_id");

-- CreateIndex
CREATE UNIQUE INDEX "edge_omission_previews_facility_id_snapshot_id_key" ON "edge_omission_previews"("facility_id", "snapshot_id");

-- CreateIndex
CREATE INDEX "edge_topology_aliases_facility_id_canonical_id_idx" ON "edge_topology_aliases"("facility_id", "canonical_id");

-- CreateIndex
CREATE UNIQUE INDEX "edge_topology_alias_edge_ref_key" ON "edge_topology_aliases"("facility_id", "edge_installation_id", "enrollment_generation", "kind", "edge_ref");

-- CreateIndex
CREATE UNIQUE INDEX "edge_topology_alias_canonical_id_key" ON "edge_topology_aliases"("facility_id", "edge_installation_id", "enrollment_generation", "kind", "canonical_id");

-- CreateIndex
CREATE INDEX "edge_ownership_transfers_facility_id_created_at_idx" ON "edge_ownership_transfers"("facility_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "edge_ownership_transfers_facility_id_edge_installation_id_e_key" ON "edge_ownership_transfers"("facility_id", "edge_installation_id", "enrollment_generation", "manifest_digest");

-- CreateIndex
CREATE INDEX "edge_validation_grants_facility_id_status_expires_at_idx" ON "edge_validation_grants"("facility_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "edge_provisioning_audit_history_facility_id_occurred_at_idx" ON "edge_provisioning_audit_history"("facility_id", "occurred_at");

-- CreateIndex
CREATE INDEX "edge_provisioning_audit_history_operation_id_idx" ON "edge_provisioning_audit_history"("operation_id");

-- CreateIndex
CREATE INDEX "media_download_process_heartbeats_lease_expires_at_idx" ON "media_download_process_heartbeats"("lease_expires_at");

-- CreateIndex
CREATE INDEX "media_download_audits_facility_id_started_at_idx" ON "media_download_audits"("facility_id", "started_at");

-- CreateIndex
CREATE INDEX "media_download_audits_state_stream_lease_expires_at_idx" ON "media_download_audits"("state", "stream_lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_download_audits_facility_id_id_key" ON "media_download_audits"("facility_id", "id");

-- CreateIndex
CREATE INDEX "media_download_outbox_jobs_facility_id_state_next_attempt_a_idx" ON "media_download_outbox_jobs"("facility_id", "state", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_download_outbox_jobs_facility_id_audit_id_key" ON "media_download_outbox_jobs"("facility_id", "audit_id");

-- CreateIndex
CREATE UNIQUE INDEX "cameras_facility_id_edge_installation_id_edge_ref_key" ON "cameras"("facility_id", "edge_installation_id", "edge_ref");

-- CreateIndex
CREATE UNIQUE INDEX "facilities_edge_code_key" ON "facilities"("edge_code");

-- CreateIndex
CREATE UNIQUE INDEX "floors_facility_id_edge_installation_id_edge_ref_key" ON "floors"("facility_id", "edge_installation_id", "edge_ref");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_facility_id_edge_installation_id_edge_ref_key" ON "spaces"("facility_id", "edge_installation_id", "edge_ref");

-- CreateIndex
CREATE UNIQUE INDEX "users_managed_identity_key_key" ON "users"("managed_identity_key");

-- AddForeignKey
ALTER TABLE "cameras" ADD CONSTRAINT "cameras_facility_id_edge_installation_id_fkey" FOREIGN KEY ("facility_id", "edge_installation_id") REFERENCES "edge_installations"("facility_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floors" ADD CONSTRAINT "floors_facility_id_edge_installation_id_fkey" FOREIGN KEY ("facility_id", "edge_installation_id") REFERENCES "edge_installations"("facility_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_facility_id_edge_installation_id_fkey" FOREIGN KEY ("facility_id", "edge_installation_id") REFERENCES "edge_installations"("facility_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_installations" ADD CONSTRAINT "edge_installations_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_installation_generations" ADD CONSTRAINT "edge_installation_generations_facility_id_edge_installatio_fkey" FOREIGN KEY ("facility_id", "edge_installation_id") REFERENCES "edge_installations"("facility_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_credentials" ADD CONSTRAINT "edge_credentials_facility_id_edge_installation_id_enrollme_fkey" FOREIGN KEY ("facility_id", "edge_installation_id", "enrollment_generation") REFERENCES "edge_installation_generations"("facility_id", "edge_installation_id", "enrollment_generation") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_admin_operations" ADD CONSTRAINT "edge_admin_operations_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_topology_snapshots" ADD CONSTRAINT "edge_topology_snapshots_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_topology_snapshots" ADD CONSTRAINT "edge_topology_snapshots_facility_id_edge_installation_id_e_fkey" FOREIGN KEY ("facility_id", "edge_installation_id", "enrollment_generation") REFERENCES "edge_installation_generations"("facility_id", "edge_installation_id", "enrollment_generation") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_omission_previews" ADD CONSTRAINT "edge_omission_previews_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_omission_previews" ADD CONSTRAINT "edge_omission_previews_facility_id_edge_installation_id_en_fkey" FOREIGN KEY ("facility_id", "edge_installation_id", "enrollment_generation") REFERENCES "edge_installation_generations"("facility_id", "edge_installation_id", "enrollment_generation") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_omission_previews" ADD CONSTRAINT "edge_omission_previews_facility_id_snapshot_id_fkey" FOREIGN KEY ("facility_id", "snapshot_id") REFERENCES "edge_topology_snapshots"("facility_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_topology_aliases" ADD CONSTRAINT "edge_topology_aliases_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_topology_aliases" ADD CONSTRAINT "edge_topology_aliases_facility_id_edge_installation_id_enr_fkey" FOREIGN KEY ("facility_id", "edge_installation_id", "enrollment_generation") REFERENCES "edge_installation_generations"("facility_id", "edge_installation_id", "enrollment_generation") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_ownership_transfers" ADD CONSTRAINT "edge_ownership_transfers_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_ownership_transfers" ADD CONSTRAINT "edge_ownership_transfers_facility_id_edge_installation_id__fkey" FOREIGN KEY ("facility_id", "edge_installation_id", "enrollment_generation") REFERENCES "edge_installation_generations"("facility_id", "edge_installation_id", "enrollment_generation") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_validation_grants" ADD CONSTRAINT "edge_validation_grants_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_validation_grants" ADD CONSTRAINT "edge_validation_grants_facility_id_edge_installation_id_en_fkey" FOREIGN KEY ("facility_id", "edge_installation_id", "enrollment_generation") REFERENCES "edge_installation_generations"("facility_id", "edge_installation_id", "enrollment_generation") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_provisioning_audit_history" ADD CONSTRAINT "edge_provisioning_audit_history_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_provisioning_audit_history" ADD CONSTRAINT "edge_provisioning_audit_history_facility_id_edge_installat_fkey" FOREIGN KEY ("facility_id", "edge_installation_id") REFERENCES "edge_installations"("facility_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_download_audits" ADD CONSTRAINT "media_download_audits_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_download_audits" ADD CONSTRAINT "media_download_audits_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "media_download_process_heartbeats"("process_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_download_outbox_jobs" ADD CONSTRAINT "media_download_outbox_jobs_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_download_outbox_jobs" ADD CONSTRAINT "media_download_outbox_jobs_facility_id_audit_id_fkey" FOREIGN KEY ("facility_id", "audit_id") REFERENCES "media_download_audits"("facility_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_download_outbox_jobs" ADD CONSTRAINT "media_download_outbox_jobs_locked_by_process_id_fkey" FOREIGN KEY ("locked_by_process_id") REFERENCES "media_download_process_heartbeats"("process_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Frozen identity, revision, lifecycle, and ownership invariants that Prisma
-- cannot express directly.
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_edge_code_check"
  CHECK ("edge_code" IS NULL OR "edge_code" ~ '^NH-[0-9A-HJKMNP-TV-Z]{10}$');
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_topology_revision_check"
  CHECK ("topology_revision" >= 0);
ALTER TABLE "edge_installations" ADD CONSTRAINT "edge_installations_current_generation_check"
  CHECK ("current_generation" > 0);
ALTER TABLE "edge_installation_generations" ADD CONSTRAINT "edge_installation_generations_revision_check"
  CHECK ("enrollment_generation" > 0 AND "accepted_client_revision" >= 0);
ALTER TABLE "edge_credentials" ADD CONSTRAINT "edge_credentials_token_id_check"
  CHECK ("token_id" ~ '^[0-9A-HJKMNP-TV-Z]{12}$');
ALTER TABLE "edge_credentials" ADD CONSTRAINT "edge_credentials_digest_check"
  CHECK ("token_digest" ~ '^[0-9a-f]{64}$');
ALTER TABLE "edge_credentials" ADD CONSTRAINT "edge_credentials_lifecycle_timestamps_check"
  CHECK (
    ("lifecycle" <> 'GRACE' OR "grace_expires_at" IS NOT NULL)
    AND ("lifecycle" <> 'REVOKED' OR "revoked_at" IS NOT NULL)
  );
ALTER TABLE "edge_topology_snapshots" ADD CONSTRAINT "edge_topology_snapshots_revision_check"
  CHECK ("enrollment_generation" > 0 AND "client_revision" > 0 AND "expected_server_revision" >= 0 AND ("server_revision" IS NULL OR "server_revision" >= 0));
ALTER TABLE "edge_topology_snapshots" ADD CONSTRAINT "edge_topology_snapshots_body_hash_check"
  CHECK ("body_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "edge_omission_previews" ADD CONSTRAINT "edge_omission_previews_digest_check"
  CHECK ("digest" ~ '^[0-9a-f]{64}$' AND "server_revision" >= 0 AND "expires_at" > "created_at");
ALTER TABLE "edge_ownership_transfers" ADD CONSTRAINT "edge_ownership_transfers_manifest_check"
  CHECK (
    "manifest_digest" ~ '^[0-9a-f]{64}$'
    AND "expected_server_revision" >= 0
    AND jsonb_typeof("manifest") = 'array'
    AND jsonb_array_length("manifest") > 0
    AND (
      ("status" = 'SUCCEEDED' AND "result" IS NOT NULL AND "applied_at" IS NOT NULL AND "applied_server_revision" = "expected_server_revision" + 1)
      OR ("status" <> 'SUCCEEDED' AND "applied_at" IS NULL AND "applied_server_revision" IS NULL)
    )
  );
ALTER TABLE "edge_validation_grants" ADD CONSTRAINT "edge_validation_grants_expiry_check"
  CHECK ("expires_at" > "created_at");

ALTER TABLE "floors" ADD CONSTRAINT "floors_edge_ownership_check" CHECK (
  ("provisioning_source" = 'PRODUCT' AND "edge_installation_id" IS NULL AND "edge_ref" IS NULL)
  OR ("provisioning_source" = 'EDGE' AND "edge_installation_id" IS NOT NULL AND "edge_ref" ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$')
);
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_edge_ownership_check" CHECK (
  ("provisioning_source" = 'PRODUCT' AND "edge_installation_id" IS NULL AND "edge_ref" IS NULL)
  OR ("provisioning_source" = 'EDGE' AND "edge_installation_id" IS NOT NULL AND "edge_ref" ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$')
);
ALTER TABLE "cameras" ADD CONSTRAINT "cameras_edge_ownership_check" CHECK (
  ("provisioning_source" = 'PRODUCT' AND "edge_installation_id" IS NULL AND "edge_ref" IS NULL)
  OR ("provisioning_source" = 'EDGE' AND "edge_installation_id" IS NOT NULL AND "edge_ref" ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$')
);
ALTER TABLE "edge_topology_aliases" ADD CONSTRAINT "edge_topology_aliases_edge_ref_check"
  CHECK ("edge_ref" ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$');

ALTER TABLE "media_download_audits" ADD CONSTRAINT "media_download_audits_lease_version_check"
  CHECK ("lease_version" > 0);
ALTER TABLE "media_download_audits" ADD CONSTRAINT "media_download_audits_range_check"
  CHECK ("range_start" IS NULL OR "range_end" IS NULL OR ("range_start" >= 0 AND "range_end" >= "range_start"));
ALTER TABLE "media_download_audits" ADD CONSTRAINT "media_download_audits_terminal_state_check" CHECK (
  ("state" = 'STARTED' AND "completed_at" IS NULL AND "aborted_at" IS NULL)
  OR ("state" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "aborted_at" IS NULL)
  OR ("state" = 'ABORTED' AND "aborted_at" IS NOT NULL AND "completed_at" IS NULL)
);
ALTER TABLE "media_download_outbox_jobs" ADD CONSTRAINT "media_download_outbox_jobs_recovery_check"
  CHECK ("lease_version" > 0 AND "attempt_count" >= 0 AND ("state" <> 'COMPLETED' OR "completed_at" IS NOT NULL));

-- Current installation generation must resolve at transaction commit, while
-- allowing installation and generation rows to be created in either order.
ALTER TABLE "edge_installations" ADD CONSTRAINT "edge_installations_current_generation_fkey"
  FOREIGN KEY ("facility_id", "id", "current_generation")
  REFERENCES "edge_installation_generations"("facility_id", "edge_installation_id", "enrollment_generation")
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION "prevent_managed_identity_key_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."managed_identity_key" IS NOT NULL
     AND NEW."managed_identity_key" IS DISTINCT FROM OLD."managed_identity_key" THEN
    RAISE EXCEPTION 'managed_identity_key is immutable once assigned';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "users_managed_identity_key_immutable"
  BEFORE UPDATE OF "managed_identity_key" ON "users"
  FOR EACH ROW EXECUTE FUNCTION "prevent_managed_identity_key_change"();

CREATE FUNCTION "validate_edge_topology_alias"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'FLOOR' AND NEW."parent_canonical_id" IS NULL AND EXISTS (
    SELECT 1 FROM "floors" WHERE "facility_id" = NEW."facility_id" AND "id" = NEW."canonical_id"
  ) THEN RETURN NEW; END IF;
  IF NEW."kind" = 'ROOM' AND EXISTS (
    SELECT 1 FROM "spaces" WHERE "facility_id" = NEW."facility_id" AND "id" = NEW."canonical_id" AND "floor_id" = NEW."parent_canonical_id"
  ) THEN RETURN NEW; END IF;
  IF NEW."kind" = 'CAMERA' AND EXISTS (
    SELECT 1 FROM "cameras" WHERE "facility_id" = NEW."facility_id" AND "id" = NEW."canonical_id" AND "space_id" = NEW."parent_canonical_id"
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'topology alias canonical parent is not in the same facility';
END $$;
CREATE TRIGGER "edge_topology_alias_parent_guard"
  BEFORE INSERT OR UPDATE ON "edge_topology_aliases"
  FOR EACH ROW EXECUTE FUNCTION "validate_edge_topology_alias"();

CREATE FUNCTION "validate_edge_transfer_manifest"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (
    SELECT count(*) <> count(DISTINCT (
      item->>'kind',
      item->>'edgeRef',
      item->>'canonicalId',
      item->>'parentCanonicalId'
    ))
    FROM jsonb_array_elements(NEW."manifest") item
  ) OR EXISTS (
    SELECT alias."kind"::text, alias."edge_ref", alias."canonical_id", alias."parent_canonical_id"
    FROM "edge_topology_aliases" alias
    WHERE alias."facility_id" = NEW."facility_id"
      AND alias."edge_installation_id" = NEW."edge_installation_id"
      AND alias."enrollment_generation" = NEW."enrollment_generation"
    EXCEPT
    SELECT item->>'kind', item->>'edgeRef', item->>'canonicalId', item->>'parentCanonicalId'
    FROM jsonb_array_elements(NEW."manifest") item
  ) OR EXISTS (
    SELECT item->>'kind', item->>'edgeRef', item->>'canonicalId', item->>'parentCanonicalId'
    FROM jsonb_array_elements(NEW."manifest") item
    EXCEPT
    SELECT alias."kind"::text, alias."edge_ref", alias."canonical_id", alias."parent_canonical_id"
    FROM "edge_topology_aliases" alias
    WHERE alias."facility_id" = NEW."facility_id"
      AND alias."edge_installation_id" = NEW."edge_installation_id"
      AND alias."enrollment_generation" = NEW."enrollment_generation"
  ) THEN
    RAISE EXCEPTION 'ownership transfer manifest must exactly match persisted aliases';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "edge_transfer_manifest_guard"
  BEFORE INSERT ON "edge_ownership_transfers"
  FOR EACH ROW EXECUTE FUNCTION "validate_edge_transfer_manifest"();

CREATE FUNCTION "require_edge_ownership_transfer"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entity_kind text;
  entity_parent_id text;
BEGIN
  IF OLD."provisioning_source" = 'PRODUCT' AND NEW."provisioning_source" = 'EDGE' THEN
    IF TG_TABLE_NAME = 'floors' THEN
      entity_kind := 'FLOOR';
      entity_parent_id := NULL;
    ELSIF TG_TABLE_NAME = 'spaces' THEN
      entity_kind := 'ROOM';
      entity_parent_id := NEW."floor_id";
    ELSE
      entity_kind := 'CAMERA';
      entity_parent_id := NEW."space_id";
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "edge_ownership_transfers" transfer
      JOIN "edge_installations" installation
        ON installation."facility_id" = transfer."facility_id"
       AND installation."id" = transfer."edge_installation_id"
       AND installation."current_generation" = transfer."enrollment_generation"
      JOIN "facilities" facility ON facility."id" = transfer."facility_id"
      CROSS JOIN jsonb_array_elements(transfer."manifest") item
      WHERE transfer."facility_id" = NEW."facility_id"
        AND transfer."edge_installation_id" = NEW."edge_installation_id"
        AND transfer."status" = 'SUCCEEDED'
        AND transfer."result" IS NOT NULL
        AND transfer."applied_at" IS NOT NULL
        AND transfer."applied_server_revision" = transfer."expected_server_revision" + 1
        AND facility."topology_revision" = transfer."applied_server_revision"
        AND item->>'kind' = entity_kind
        AND item->>'canonicalId' = NEW."id"
        AND item->>'edgeRef' = NEW."edge_ref"
        AND item->>'parentCanonicalId' IS NOT DISTINCT FROM entity_parent_id
    ) THEN RAISE EXCEPTION 'PRODUCT ownership requires an explicit transfer manifest'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "floors_edge_ownership_transfer_guard" BEFORE UPDATE ON "floors"
  FOR EACH ROW EXECUTE FUNCTION "require_edge_ownership_transfer"();
CREATE TRIGGER "spaces_edge_ownership_transfer_guard" BEFORE UPDATE ON "spaces"
  FOR EACH ROW EXECUTE FUNCTION "require_edge_ownership_transfer"();
CREATE TRIGGER "cameras_edge_ownership_transfer_guard" BEFORE UPDATE ON "cameras"
  FOR EACH ROW EXECUTE FUNCTION "require_edge_ownership_transfer"();

CREATE FUNCTION "prevent_edge_immutable_changes"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'edge_admin_operations' THEN
    IF NEW."facility_id" IS DISTINCT FROM OLD."facility_id"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."operation_type" IS DISTINCT FROM OLD."operation_type"
       OR NEW."body_hash" IS DISTINCT FROM OLD."body_hash" THEN
      RAISE EXCEPTION 'edge operation identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'edge_topology_snapshots' THEN
    IF NEW."facility_id" IS DISTINCT FROM OLD."facility_id"
       OR NEW."edge_installation_id" IS DISTINCT FROM OLD."edge_installation_id"
       OR NEW."enrollment_generation" IS DISTINCT FROM OLD."enrollment_generation"
       OR NEW."client_revision" IS DISTINCT FROM OLD."client_revision"
       OR NEW."expected_server_revision" IS DISTINCT FROM OLD."expected_server_revision"
       OR NEW."body_hash" IS DISTINCT FROM OLD."body_hash"
       OR NEW."canonical_body" IS DISTINCT FROM OLD."canonical_body" THEN
      RAISE EXCEPTION 'topology snapshot request is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'edge_ownership_transfers' THEN
    IF NEW."facility_id" IS DISTINCT FROM OLD."facility_id"
       OR NEW."edge_installation_id" IS DISTINCT FROM OLD."edge_installation_id"
       OR NEW."enrollment_generation" IS DISTINCT FROM OLD."enrollment_generation"
       OR NEW."expected_server_revision" IS DISTINCT FROM OLD."expected_server_revision"
       OR NEW."manifest_digest" IS DISTINCT FROM OLD."manifest_digest"
       OR NEW."manifest" IS DISTINCT FROM OLD."manifest" THEN
      RAISE EXCEPTION 'ownership transfer manifest is immutable';
    END IF;
    IF OLD."status" IN ('SUCCEEDED', 'FAILED', 'UNKNOWN') AND (
      NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."result" IS DISTINCT FROM OLD."result"
      OR NEW."applied_server_revision" IS DISTINCT FROM OLD."applied_server_revision"
      OR NEW."applied_at" IS DISTINCT FROM OLD."applied_at"
    ) THEN
      RAISE EXCEPTION 'ownership transfer terminal result is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "edge_admin_operation_identity_immutable" BEFORE UPDATE ON "edge_admin_operations"
  FOR EACH ROW EXECUTE FUNCTION "prevent_edge_immutable_changes"();
CREATE TRIGGER "edge_topology_snapshot_request_immutable" BEFORE UPDATE ON "edge_topology_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "prevent_edge_immutable_changes"();
CREATE TRIGGER "edge_ownership_transfer_manifest_immutable" BEFORE UPDATE ON "edge_ownership_transfers"
  FOR EACH ROW EXECUTE FUNCTION "prevent_edge_immutable_changes"();

CREATE FUNCTION "require_media_download_outbox_job"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "media_download_outbox_jobs"
    WHERE "facility_id" = NEW."facility_id" AND "audit_id" = NEW."id"
  ) THEN RAISE EXCEPTION 'STARTED download audit requires a pending outbox job'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "media_download_audit_requires_outbox"
  AFTER INSERT ON "media_download_audits"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "require_media_download_outbox_job"();

-- Tenant-scoped state remains protected by the existing transaction GUC.
ALTER TABLE "edge_topology_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "edge_topology_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "edge_topology_snapshots"
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
ALTER TABLE "edge_omission_previews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "edge_omission_previews" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "edge_omission_previews"
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
ALTER TABLE "edge_topology_aliases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "edge_topology_aliases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "edge_topology_aliases"
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
ALTER TABLE "edge_ownership_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "edge_ownership_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "edge_ownership_transfers"
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
ALTER TABLE "edge_validation_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "edge_validation_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "edge_validation_grants"
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
ALTER TABLE "edge_provisioning_audit_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "edge_provisioning_audit_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "edge_provisioning_audit_history"
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
ALTER TABLE "media_download_audits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_download_audits" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "media_download_audits"
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);
ALTER TABLE "media_download_outbox_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_download_outbox_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "media_download_outbox_jobs"
  USING (facility_id = current_setting('app.facility_id', true)::text)
  WITH CHECK (facility_id = current_setting('app.facility_id', true)::text);

REVOKE ALL ON "edge_installations", "edge_installation_generations", "edge_credentials", "edge_admin_operations", "edge_topology_snapshots", "edge_omission_previews", "edge_topology_aliases", "edge_ownership_transfers", "edge_validation_grants", "edge_provisioning_audit_history", "media_download_process_heartbeats", "media_download_audits", "media_download_outbox_jobs" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "edge_provisioning_audit_history_id_seq" FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON "edge_installations", "edge_installation_generations", "edge_credentials", "edge_admin_operations" TO fall_app;
GRANT SELECT, INSERT, UPDATE ON "edge_topology_snapshots", "edge_omission_previews", "edge_ownership_transfers", "edge_validation_grants" TO fall_app;
GRANT SELECT, INSERT ON "edge_topology_aliases", "edge_provisioning_audit_history" TO fall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "media_download_process_heartbeats" TO fall_app;
GRANT SELECT, INSERT, UPDATE ON "media_download_audits", "media_download_outbox_jobs" TO fall_app;
GRANT USAGE, SELECT ON SEQUENCE "edge_provisioning_audit_history_id_seq" TO fall_app;
