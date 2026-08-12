import type { PrismaClient } from '@prisma/client';
import { tokenDigest } from '../../src/edge-credentials/edge-credential-crypto.js';
import {
  FACILITY_ID,
  INSTALLATION_ID,
  MULTI_PRODUCT_CAMERA_ID_1,
  MULTI_PRODUCT_CAMERA_ID_2,
  MULTI_PRODUCT_FLOOR_ID,
  MULTI_PRODUCT_ROOM_ID_1,
  MULTI_PRODUCT_ROOM_ID_2,
  OTHER_FACILITY_ID,
  OTHER_INSTALLATION_ID,
  PRODUCT_CAMERA_ID,
  PRODUCT_FLOOR_ID,
  PRODUCT_ROOM_ID,
  TOKEN,
} from './edge-topology-fixture-values.js';

export async function resetTopologyDb(
  admin: PrismaClient,
  pepper: string,
): Promise<void> {
  await cleanupTopologyDb(admin);
  await admin.facility.createMany({
    data: [
      {
        id: FACILITY_ID,
        name: 'Topology Facility',
        edgeCode: 'NH-7H2K9M4QXP',
      },
      {
        id: OTHER_FACILITY_ID,
        name: 'Other Facility',
        edgeCode: 'NH-7H2K9M4QXQ',
      },
    ],
  });
  await admin.edgeInstallation.create({
    data: {
      id: INSTALLATION_ID,
      facilityId: FACILITY_ID,
      generations: {
        create: {
          generation: 1,
          state: 'CLAIMED',
          clientInstallationRef: '8b0f5ba2-d359-4d8e-948f-e386ac40c347',
        },
      },
    },
  });
  await admin.edgeCredential.create({
    data: {
      tokenId: '0123456789AB',
      tokenDigest: tokenDigest(pepper, TOKEN).toString('hex'),
      tokenPrefix: 'eft_v1.0123456789AB',
      facilityId: FACILITY_ID,
      edgeInstallationId: INSTALLATION_ID,
      enrollmentGeneration: 1,
    },
  });
}

export async function seedProductTopology(
  admin: PrismaClient,
  facilityId: string,
): Promise<void> {
  await admin.floor.create({
    data: {
      id: PRODUCT_FLOOR_ID,
      facilityId,
      name: 'Product Floor',
      orderIndex: 1,
    },
  });
  await admin.space.create({
    data: {
      id: PRODUCT_ROOM_ID,
      facilityId,
      floorId: PRODUCT_FLOOR_ID,
      name: 'Product Room',
      type: 'ROOM',
      capacity: 1,
    },
  });
  await admin.camera.create({
    data: {
      id: PRODUCT_CAMERA_ID,
      facilityId,
      spaceId: PRODUCT_ROOM_ID,
      label: 'Product Camera',
    },
  });
}

export async function seedMultiRoomProductTopology(
  admin: PrismaClient,
  facilityId: string,
): Promise<void> {
  await admin.floor.create({
    data: {
      id: MULTI_PRODUCT_FLOOR_ID,
      facilityId,
      name: 'Multi Product Floor',
      orderIndex: 2,
    },
  });
  await admin.space.create({
    data: {
      id: MULTI_PRODUCT_ROOM_ID_1,
      facilityId,
      floorId: MULTI_PRODUCT_FLOOR_ID,
      name: 'Multi Product Room 1',
      type: 'ROOM',
      capacity: 1,
    },
  });
  await admin.camera.create({
    data: {
      id: MULTI_PRODUCT_CAMERA_ID_1,
      facilityId,
      spaceId: MULTI_PRODUCT_ROOM_ID_1,
      label: 'Multi Product Camera 1',
    },
  });
  await admin.space.create({
    data: {
      id: MULTI_PRODUCT_ROOM_ID_2,
      facilityId,
      floorId: MULTI_PRODUCT_FLOOR_ID,
      name: 'Multi Product Room 2',
      type: 'ROOM',
      capacity: 1,
    },
  });
  await admin.camera.create({
    data: {
      id: MULTI_PRODUCT_CAMERA_ID_2,
      facilityId,
      spaceId: MULTI_PRODUCT_ROOM_ID_2,
      label: 'Multi Product Camera 2',
    },
  });
}

export async function seedOtherInstallationTopology(
  admin: PrismaClient,
): Promise<void> {
  await admin.edgeInstallation.create({
    data: {
      id: OTHER_INSTALLATION_ID,
      facilityId: FACILITY_ID,
      generations: {
        create: {
          generation: 1,
          state: 'CLAIMED',
          clientInstallationRef: '9b0f5ba2-d359-4d8e-948f-e386ac40c347',
        },
      },
    },
  });
  const floor = await admin.floor.create({
    data: {
      facilityId: FACILITY_ID,
      name: 'Other Edge Floor',
      orderIndex: 9,
      provisioningSource: 'EDGE',
      edgeInstallationId: OTHER_INSTALLATION_ID,
      edgeRef: 'other-floor',
    },
  });
  const room = await admin.space.create({
    data: {
      facilityId: FACILITY_ID,
      floorId: floor.id,
      name: 'Other Edge Room',
      type: 'ROOM',
      capacity: 1,
      provisioningSource: 'EDGE',
      edgeInstallationId: OTHER_INSTALLATION_ID,
      edgeRef: 'other-room',
    },
  });
  await admin.camera.create({
    data: {
      facilityId: FACILITY_ID,
      spaceId: room.id,
      label: 'Other Edge Camera',
      provisioningSource: 'EDGE',
      edgeInstallationId: OTHER_INSTALLATION_ID,
      edgeRef: 'other-camera',
    },
  });
}

export async function cleanupTopologyDb(admin: PrismaClient): Promise<void> {
  const facilities = [FACILITY_ID, OTHER_FACILITY_ID];
  await admin.event.deleteMany({ where: { facilityId: { in: facilities } } });
  await admin.edgeProvisioningAudit.deleteMany({
    where: { facilityId: { in: facilities } },
  });
  await admin.edgeOmissionPreview.deleteMany({
    where: { facilityId: { in: facilities } },
  });
  await admin.edgeTopologySnapshot.deleteMany({
    where: { facilityId: { in: facilities } },
  });
  await admin.edgeOwnershipTransfer.deleteMany({
    where: { facilityId: { in: facilities } },
  });
  await admin.edgeTopologyAlias.deleteMany({
    where: { facilityId: { in: facilities } },
  });
  await admin.edgeCredential.deleteMany({
    where: { facilityId: { in: facilities } },
  });
  await admin.edgeAdminOperation.deleteMany({
    where: { facilityId: { in: facilities } },
  });
  await admin.camera.deleteMany({ where: { facilityId: { in: facilities } } });
  await admin.space.deleteMany({ where: { facilityId: { in: facilities } } });
  await admin.floor.deleteMany({ where: { facilityId: { in: facilities } } });
  await admin.edgeInstallation.deleteMany({
    where: { facilityId: { in: facilities } },
  });
  await admin.mlFacilityConfig.deleteMany({
    where: { facilityId: { in: facilities } },
  });
  await admin.facility.deleteMany({ where: { id: { in: facilities } } });
}
