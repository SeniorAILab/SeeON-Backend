import type { PrismaClient } from '@prisma/client';

export const EDGE_ENROLLMENT_FACILITY_ID =
  'e1100001-0000-4000-8000-000000000001';
export const EDGE_ENROLLMENT_OTHER_FACILITY_ID =
  'e1100001-0000-4000-8000-000000000002';
export const EDGE_ENROLLMENT_CAMERA_ID = 'e1100004-0000-4000-8000-000000000001';
export const EDGE_ENROLLMENT_SPACE_ID = 'e1100003-0000-4000-8000-000000000001';
export const EDGE_ENROLLMENT_FLOOR_ID = 'e1100002-0000-4000-8000-000000000001';
export const EDGE_ENROLLMENT_FIXTURE_IDS = [
  EDGE_ENROLLMENT_FACILITY_ID,
  EDGE_ENROLLMENT_OTHER_FACILITY_ID,
  EDGE_ENROLLMENT_FLOOR_ID,
  EDGE_ENROLLMENT_SPACE_ID,
  EDGE_ENROLLMENT_CAMERA_ID,
] as const;
export const EDGE_ENROLLMENT_IDEMPOTENCY_KEY_PREFIX =
  '0197f671-3a31-7a6c-a6e4-e110';

export function edgeEnrollmentUuidV7(sequence: number): string {
  return `${EDGE_ENROLLMENT_IDEMPOTENCY_KEY_PREFIX}${sequence.toString(16).padStart(8, '0')}`;
}

export async function cleanupEdgeEnrollmentFixtures(
  admin: PrismaClient,
): Promise<void> {
  const facilityIds = [
    EDGE_ENROLLMENT_FACILITY_ID,
    EDGE_ENROLLMENT_OTHER_FACILITY_ID,
  ];
  await admin.event.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.edgeProvisioningAudit.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.edgeValidationGrant.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.edgeOwnershipTransfer.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.edgeTopologyAlias.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.edgeCredential.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.edgeAdminOperation.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.camera.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.space.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.floor.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.edgeInstallation.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await admin.facility.deleteMany({
    where: { id: { in: facilityIds } },
  });
}
