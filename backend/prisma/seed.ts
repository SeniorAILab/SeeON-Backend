import type { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import {
  NOKYANG_ADMIN_EMAIL,
  NOKYANG_FACILITY_ID,
  nokyangAssignments,
  nokyangCameras,
  nokyangFacility,
  nokyangFloors,
  nokyangGuardians,
  nokyangResidents,
  nokyangSpaces,
  nokyangStatuses,
  nokyangZones,
  verifyNokyangFixture,
} from './demo-nokyang.fixture';
import { hashPassword } from '../src/auth/password';

const directUrl = process.env.DIRECT_URL;
if (!directUrl) {
  throw new Error('DIRECT_URL must be set for privileged seed execution');
}

const prisma = new PrismaClient({
  datasources: { db: { url: directUrl } },
});

async function upsertFacility(tx: Prisma.TransactionClient): Promise<void> {
  await tx.facility.upsert({
    where: { id: NOKYANG_FACILITY_ID },
    update: {
      address: nokyangFacility.address,
      businessRegistrationNumber: nokyangFacility.businessRegistrationNumber,
      code: nokyangFacility.code,
      name: nokyangFacility.name,
      phone: nokyangFacility.phone,
    },
    create: nokyangFacility,
  });
}

async function upsertAdmin(tx: Prisma.TransactionClient): Promise<void> {
  const demoLoginPassword = process.env.DEMO_LOGIN_PASSWORD ?? '1234';
  const passwordHash = await hashPassword(demoLoginPassword);
  await tx.user.upsert({
    where: { email: NOKYANG_ADMIN_EMAIL },
    update: {
      facilityId: NOKYANG_FACILITY_ID,
      nickname: '녹양역점 관리자',
      passwordHash,
      role: 'ADMIN',
      sessionVersion: { increment: 1 },
    },
    create: {
      email: NOKYANG_ADMIN_EMAIL,
      facilityId: NOKYANG_FACILITY_ID,
      id: 'user_nokyang_admin',
      nickname: '녹양역점 관리자',
      passwordHash,
      role: 'ADMIN',
    },
  });
}

async function upsertFacilityGraph(
  tx: Prisma.TransactionClient,
): Promise<void> {
  for (const floor of nokyangFloors) {
    await tx.floor.upsert({
      where: { facilityId_id: { facilityId: floor.facilityId, id: floor.id } },
      update: {
        name: floor.name,
        orderIndex: floor.orderIndex,
      },
      create: floor,
    });
  }

  for (const space of nokyangSpaces) {
    await tx.space.upsert({
      where: { facilityId_id: { facilityId: space.facilityId, id: space.id } },
      update: {
        assignedStaff: space.assignedStaff,
        capacity: space.capacity,
        floorId: space.floorId,
        isActive: true,
        name: space.name,
        type: space.type,
      },
      create: space,
    });
  }

  for (const zone of nokyangZones) {
    await tx.zone.upsert({
      where: { facilityId_id: { facilityId: zone.facilityId, id: zone.id } },
      update: {
        name: zone.name,
        orderIndex: zone.orderIndex,
        spaceId: zone.spaceId,
        type: zone.type,
      },
      create: zone,
    });
  }
}

async function upsertResidents(tx: Prisma.TransactionClient): Promise<void> {
  for (const resident of nokyangResidents) {
    await tx.resident.upsert({
      where: {
        facilityId_id: {
          facilityId: resident.facilityId,
          id: resident.id,
        },
      },
      update: {
        age: resident.age,
        diagnosisTags: [...resident.diagnosisTags],
        fallRiskBaseline: resident.fallRiskBaseline,
        gender: resident.gender,
        isActive: true,
        isFocusResident: resident.isFocusResident,
        name: resident.name,
      },
      create: {
        ...resident,
        diagnosisTags: [...resident.diagnosisTags],
      },
    });
  }

  for (const assignment of nokyangAssignments) {
    await tx.residentAssignment.upsert({
      where: {
        facilityId_id: {
          facilityId: assignment.facilityId,
          id: assignment.id,
        },
      },
      update: {
        endedAt: null,
        residentId: assignment.residentId,
        spaceId: assignment.spaceId,
        startedAt: assignment.startedAt,
        zoneId: assignment.zoneId,
      },
      create: assignment,
    });
  }

  for (const guardian of nokyangGuardians) {
    await tx.guardian.upsert({
      where: { id: guardian.id },
      update: {
        name: guardian.name,
        phone: guardian.phone,
        relation: guardian.relation,
        residentId: guardian.residentId,
      },
      create: guardian,
    });
  }
}

async function upsertCameras(tx: Prisma.TransactionClient): Promise<void> {
  for (const camera of nokyangCameras) {
    await tx.camera.upsert({
      where: {
        facilityId_id: {
          facilityId: camera.facilityId,
          id: camera.id,
        },
      },
      update: {
        label: camera.label,
        online: true,
        spaceId: camera.spaceId,
      },
      create: {
        ...camera,
        online: true,
      },
    });
  }
}

async function upsertStatuses(tx: Prisma.TransactionClient): Promise<void> {
  for (const status of nokyangStatuses) {
    await tx.residentStatus.upsert({
      where: { residentId: status.residentId },
      update: {
        cameraOnline: status.cameraOnline,
        facilityId: status.facilityId,
        sourceId: status.sourceId,
        state: status.state,
      },
      create: status,
    });
  }
}

async function seedNokyangDemo(): Promise<void> {
  verifyNokyangFixture();
  return prisma.$transaction(async (tx) => {
    await upsertFacility(tx);
    await upsertAdmin(tx);
    await upsertFacilityGraph(tx);
    await upsertResidents(tx);
    await upsertCameras(tx);
    await upsertStatuses(tx);
  });
}

async function main(): Promise<void> {
  console.log('Seeding 녹양역점 demo data...');
  await seedNokyangDemo();
  console.log(
    `Facility: ${nokyangFacility.name} (${NOKYANG_FACILITY_ID}) Admin=${NOKYANG_ADMIN_EMAIL} role=ADMIN Floors=${nokyangFloors.length} Spaces=${nokyangSpaces.length} Zones=${nokyangZones.length} Residents=${nokyangResidents.length} Cameras=${nokyangCameras.length}`,
  );
  console.log('Seed complete.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
