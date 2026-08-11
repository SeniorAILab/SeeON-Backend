import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class FacilitiesRepository {
  constructor(private readonly prisma: PrismaService) {}

  getByFacilityId(facilityId: string) {
    return this.prisma.db.facility.findUnique({
      where: { id: facilityId },
    });
  }

  listAll() {
    return this.prisma.db.facility.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  listByFacilityId(facilityId: string) {
    return this.prisma.db.facility.findMany({
      where: { id: facilityId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  updateByFacilityId(facilityId: string, data: Prisma.FacilityUpdateInput) {
    return this.prisma.db.facility.update({
      where: { id: facilityId },
      data,
    });
  }

  /**
   * Most recently created, still-active (not deactivated) Edge installation
   * for a facility. EdgeInstallation is not RLS-tenant-guarded (it is not in
   * PrismaService's TENANT_MODELS set), so this reads via `db` directly and
   * filters by facilityId explicitly — mirrors edge-admin.repository.ts.
   */
  findActiveEdgeInstallation(facilityId: string) {
    return this.prisma.db.edgeInstallation.findFirst({
      where: { facilityId, deactivatedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Camera health counts for the facility admin status block. Camera is a
   * TENANT_MODEL (RLS-guarded), so this must run inside withFacilityContext.
   * "Healthy" reuses the existing per-camera `online` flag, which is already
   * kept live by heartbeat ingest (sets true) and detection-lost events
   * (sets false) — see CamerasService.recordHeartbeat/recordOffline.
   */
  getCameraHealthCounts(facilityId: string) {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      const [healthy, total] = await Promise.all([
        tx.camera.count({ where: { isActive: true, online: true } }),
        tx.camera.count({ where: { isActive: true } }),
      ]);
      return { healthy, total };
    });
  }
}
