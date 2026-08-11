-- AlterTable
ALTER TABLE "edge_installations" ADD COLUMN     "last_heartbeat_at" TIMESTAMP(3),
ADD COLUMN     "last_synced_at" TIMESTAMP(3);
