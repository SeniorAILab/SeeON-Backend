import type { PrismaClient } from '@prisma/client';

export async function cleanupFacilityFixtures(
  direct: PrismaClient,
  facilityIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(facilityIds)];
  if (ids.length === 0) return;

  const where = { facilityId: { in: ids } };
  await direct.dashboardReceipt.deleteMany({ where });
  await direct.alertNote.deleteMany({ where });
  await direct.alert.deleteMany({ where });
  await direct.event.deleteMany({ where });
  await direct.camera.deleteMany({ where });
  await direct.user.deleteMany({ where });
  await direct.space.deleteMany({ where });
  await direct.floor.deleteMany({ where });
  await direct.facility.deleteMany({ where: { id: { in: ids } } });
}
