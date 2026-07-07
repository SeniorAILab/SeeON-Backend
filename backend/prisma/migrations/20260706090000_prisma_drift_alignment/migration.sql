-- Align committed migrations with schema.prisma so CI can block Prisma drift.

-- AlterTable
ALTER TABLE "cameras" ADD COLUMN "rtsp_url" TEXT;

-- AlterTable
ALTER TABLE "events"
  ADD COLUMN "clock_source" TEXT,
  ADD COLUMN "config_version" INTEGER,
  ADD COLUMN "detector_version" TEXT,
  ADD COLUMN "model_version" TEXT,
  ADD COLUMN "operating_threshold" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "ml_facility_config" (
    "facility_id" TEXT NOT NULL,
    "config_version" INTEGER NOT NULL DEFAULT 0,
    "night_start" TEXT NOT NULL DEFAULT '21:00',
    "night_end" TEXT NOT NULL DEFAULT '07:00',
    "tz" TEXT NOT NULL DEFAULT 'Asia/Seoul',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ml_facility_config_pkey" PRIMARY KEY ("facility_id")
);

-- AddForeignKey
ALTER TABLE "ml_facility_config"
  ADD CONSTRAINT "ml_facility_config_facility_id_fkey"
  FOREIGN KEY ("facility_id") REFERENCES "facilities"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "alert_events_source_external_event_id_key"
  RENAME TO "alert_events_source_id_external_event_id_key";
