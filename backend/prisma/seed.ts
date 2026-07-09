import type { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import {
  NOKYANG_ADMIN_EMAIL,
  NOKYANG_FACILITY_CODE,
  nokyangCameras,
  nokyangFacility,
  nokyangFloors,
  nokyangSpaces,
  verifyNokyangFixture,
} from './demo-nokyang.fixture';
import { hashPassword } from '../src/auth/password';
import { bootstrapSuperAdmin, readSuperAdminConfig } from './seed-super-admin';
import { bindDemoUsers, parseBindArgs } from '../scripts/bind-demo-users';

const directUrl = process.env.DIRECT_URL;
if (!directUrl) {
  throw new Error('DIRECT_URL must be set for privileged seed execution');
}

const prisma = new PrismaClient({
  datasources: { db: { url: directUrl } },
});

async function upsertFacility(tx: Prisma.TransactionClient): Promise<string> {
  const facility = await tx.facility.upsert({
    where: { code: nokyangFacility.code },
    update: {
      address: nokyangFacility.address,
      businessRegistrationNumber: nokyangFacility.businessRegistrationNumber,
      code: nokyangFacility.code,
      name: nokyangFacility.name,
      phone: nokyangFacility.phone,
    },
    create: nokyangFacility,
  });
  return facility.id;
}

const NOKYANG_STAFF_EMAIL = 'staff@happy-nokyang.local';
function readNokyangDemoPassword(env: NodeJS.ProcessEnv): string {
  const password = (env.NOKYANG_ADMIN_PASSWORD ?? '').trim();
  if (password.length > 0) {
    return password;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'NOKYANG_ADMIN_PASSWORD must be set for the Nokyang demo admin in production.',
    );
  }
  // Development/local: fixed demo password so the Nokyang testbed logs in with 1234
  // without any extra env flag. Production still requires an explicit secret above.
  return '1234';
}

async function upsertAdmin(
  tx: Prisma.TransactionClient,
  facilityId: string,
): Promise<void> {
  const passwordHash = await hashPassword(readNokyangDemoPassword(process.env));
  await tx.user.upsert({
    where: { email: NOKYANG_ADMIN_EMAIL },
    update: {
      facilityId,
      nickname: '녹양역점 관리자',
      passwordHash,
      role: 'ADMIN',
      sessionVersion: { increment: 1 },
    },
    create: {
      email: NOKYANG_ADMIN_EMAIL,
      facilityId,
      id: 'user_nokyang_admin',
      nickname: '녹양역점 관리자',
      passwordHash,
      role: 'ADMIN',
    },
  });
}

async function upsertStaff(
  tx: Prisma.TransactionClient,
  facilityId: string,
): Promise<void> {
  const passwordHash = await hashPassword(readNokyangDemoPassword(process.env));
  await tx.user.upsert({
    where: { email: NOKYANG_STAFF_EMAIL },
    update: {
      facilityId,
      nickname: '녹양역점 요양보호사',
      passwordHash,
      role: 'STAFF',
      sessionVersion: { increment: 1 },
    },
    create: {
      email: NOKYANG_STAFF_EMAIL,
      facilityId,
      id: 'user_nokyang_staff',
      nickname: '녹양역점 요양보호사',
      passwordHash,
      role: 'STAFF',
    },
  });
}

async function upsertFacilityGraph(
  tx: Prisma.TransactionClient,
  facilityId: string,
): Promise<void> {
  for (const floor of nokyangFloors) {
    await tx.floor.upsert({
      where: { facilityId_id: { facilityId, id: floor.id } },
      update: {
        name: floor.name,
        orderIndex: floor.orderIndex,
      },
      create: { ...floor, facilityId },
    });
  }

  for (const space of nokyangSpaces) {
    await tx.space.upsert({
      where: { facilityId_id: { facilityId, id: space.id } },
      update: {
        assignedStaff: space.assignedStaff,
        capacity: space.capacity,
        floorId: space.floorId,
        isActive: true,
        name: space.name,
        type: space.type,
      },
      create: { ...space, facilityId },
    });
  }
}

async function upsertCameras(
  tx: Prisma.TransactionClient,
  facilityId: string,
): Promise<void> {
  for (const camera of nokyangCameras) {
    await tx.camera.upsert({
      where: {
        facilityId_id: {
          facilityId,
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
        facilityId,
        online: true,
      },
    });
  }
}

async function seedNokyangDemo(): Promise<string> {
  verifyNokyangFixture();
  return prisma.$transaction(async (tx) => {
    const facilityId = await upsertFacility(tx);
    await upsertAdmin(tx, facilityId);
    await upsertStaff(tx, facilityId);
    await upsertFacilityGraph(tx, facilityId);
    await upsertCameras(tx, facilityId);
    return facilityId;
  });
}

async function main(): Promise<void> {
  console.log('Seeding 녹양역점 demo data...');
  const facilityId = await seedNokyangDemo();
  console.log(
    `Facility: ${nokyangFacility.name} (${facilityId}) Admin=${NOKYANG_ADMIN_EMAIL} Staff=${NOKYANG_STAFF_EMAIL} role=STAFF Floors=${nokyangFloors.length} Spaces=${nokyangSpaces.length} Cameras=${nokyangCameras.length}`,
  );
  if (process.env.SEED_BIND_DEMO_USERS === 'true') {
    const bindResult = await bindDemoUsers(prisma, parseBindArgs([]));
    console.log(
      `Bound ${bindResult.boundCount} Kakao demo user(s) to code ${NOKYANG_FACILITY_CODE} (${facilityId}).`,
    );
  } else {
    console.log(
      'Skipping Kakao demo user binding: set SEED_BIND_DEMO_USERS=true to run this seed module.',
    );
  }
  const superAdminConfig = readSuperAdminConfig();
  if (superAdminConfig.skip) {
    console.log(`Skipping super-admin bootstrap: ${superAdminConfig.reason}.`);
  } else {
    const action = await bootstrapSuperAdmin(prisma, superAdminConfig);
    console.log(
      `Super-admin bootstrap ${action}: email=${superAdminConfig.email} role=SUPER_ADMIN facility=${superAdminConfig.facilityId ?? '<none>'}`,
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
