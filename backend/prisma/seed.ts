import { Prisma, PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
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

type CameraSecret = {
  readonly hash: string;
  readonly keyId: string;
  readonly secret: string;
};

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeCameraSecret(label: string, fixed?: string): CameraSecret {
  const keyId = `demo-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-keyid`;
  const secret =
    fixed && fixed.length > 0 ? fixed : crypto.randomBytes(24).toString('hex');
  return { hash: sha256(secret), keyId, secret };
}

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

async function upsertFacilityGraph(tx: Prisma.TransactionClient): Promise<void> {
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

async function upsertCameras(
  tx: Prisma.TransactionClient,
): Promise<readonly CameraSecret[]> {
  const secrets: CameraSecret[] = [];
  for (const camera of nokyangCameras) {
    const cameraSecret = makeCameraSecret(
      camera.label,
      process.env.DEMO_INGEST_SECRET,
    );
    secrets.push(cameraSecret);
    await tx.camera.upsert({
      where: {
        facilityId_id: {
          facilityId: camera.facilityId,
          id: camera.id,
        },
      },
      update: {
        ingestKeyId: cameraSecret.keyId,
        ingestSecretHash: cameraSecret.hash,
        label: camera.label,
        online: true,
        spaceId: camera.spaceId,
      },
      create: {
        ...camera,
        ingestKeyId: cameraSecret.keyId,
        ingestSecretHash: cameraSecret.hash,
        online: true,
      },
    });
  }
  return secrets;
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

async function seedNokyangDemo(): Promise<readonly CameraSecret[]> {
  verifyNokyangFixture();
  return prisma.$transaction(async (tx) => {
    await upsertFacility(tx);
    await upsertAdmin(tx);
    await upsertFacilityGraph(tx);
    await upsertResidents(tx);
    const secrets = await upsertCameras(tx);
    await upsertStatuses(tx);
    return secrets;
  });
}

async function main(): Promise<void> {
  console.log('Seeding 녹양역점 demo data...');
  const cameraSecrets = await seedNokyangDemo();
  console.log(
    `Facility: ${nokyangFacility.name} (${NOKYANG_FACILITY_ID}) Admin=${NOKYANG_ADMIN_EMAIL} role=ADMIN Floors=${nokyangFloors.length} Spaces=${nokyangSpaces.length} Zones=${nokyangZones.length} Residents=${nokyangResidents.length} Cameras=${nokyangCameras.length}`,
  );
  console.log('Camera secrets (save these; only hashes are stored):');
  for (const [index, camera] of nokyangCameras.entries()) {
    const secret = cameraSecrets[index];
    if (!secret) {
      continue;
    }
    console.log(
      `  ${camera.label}: secret=${secret.secret} keyId=${secret.keyId}`,
    );
  }
  console.log('Seed complete.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
