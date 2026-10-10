import type { Prisma } from '@prisma/client';

export async function bumpMlConfigVersion(
  tx: Prisma.TransactionClient,
  facilityId: string,
): Promise<void> {
  await tx.mlFacilityConfig.upsert({
    where: { facilityId },
    create: { facilityId, configVersion: 1 },
    update: { configVersion: { increment: 1 } },
  });
}
