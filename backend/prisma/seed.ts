import type { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import {
  NOKYANG_ADMIN_EMAIL,
  nokyangCameras,
  nokyangFacility,
  nokyangFloors,
  nokyangSpaces,
  verifyNokyangFixture,
} from './demo-nokyang.fixture';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { bootstrapSuperAdmin, readSuperAdminConfig } from './seed-super-admin';

const directUrl = process.env.DIRECT_URL;
if (!directUrl) {
  throw new Error('DIRECT_URL must be set for privileged seed execution');
}

/**
 * 데모 시드 가드.
 *
 * 이 시드는 녹양 데모 시설·층·방·카메라를 만들고 카메라를 online으로 되돌린다.
 * 프로덕션에서 실수로 한 번 돌리면 운영자가 정리한 공간이 되살아나고 죽은
 * 카메라가 다시 "정상"으로 표시된다. 정기 배포 경로는 이 스크립트를 부르지
 * 않지만(iwinv-deploy.sh는 seed-super-admin.js만 실행), 수동 실행은 막아야 한다.
 *
 * 정말 프로덕션에 데모 데이터를 넣어야 하면 ALLOW_DEMO_SEED=1을 명시한다.
 */
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== '1') {
  throw new Error(
    'Refusing to run the demo seed in production. ' +
      'It recreates demo spaces/cameras and flips cameras back to online. ' +
      'Set ALLOW_DEMO_SEED=1 only if you truly intend this.',
  );
}

const prisma = new PrismaClient({
  datasources: { db: { url: directUrl } },
});

async function upsertFacility(tx: Prisma.TransactionClient): Promise<string> {
  // 멱등키: 문자 code 제거 이후 사업자등록번호(실세계 유일키)로 기존 시설을 찾는다.
  // 시설 id는 항상 DB가 발급한다.
  const existing = await tx.facility.findFirst({
    where: {
      businessRegistrationNumber: nokyangFacility.businessRegistrationNumber,
    },
    select: { id: true },
  });
  const data = {
    address: nokyangFacility.address,
    businessRegistrationNumber: nokyangFacility.businessRegistrationNumber,
    name: nokyangFacility.name,
    phone: nokyangFacility.phone,
  };
  const facility = existing
    ? await tx.facility.update({ where: { id: existing.id }, data })
    : await tx.facility.create({ data });
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
  const password = readNokyangDemoPassword(process.env);
  const existing = await tx.user.findUnique({
    where: { email: NOKYANG_ADMIN_EMAIL },
    select: { passwordHash: true },
  });
  const passwordMatches =
    existing?.passwordHash != null
      ? await verifyPassword(password, existing.passwordHash)
      : false;
  const passwordHash = passwordMatches
    ? undefined
    : await hashPassword(password);
  await tx.user.upsert({
    where: { email: NOKYANG_ADMIN_EMAIL },
    update: {
      facilityId,
      nickname: '녹양역점 관리자',
      role: 'ADMIN',
      ...(passwordMatches
        ? {}
        : {
            passwordHash,
            sessionVersion: { increment: 1 },
          }),
    },
    create: {
      email: NOKYANG_ADMIN_EMAIL,
      facilityId,
      id: 'user_nokyang_admin',
      nickname: '녹양역점 관리자',
      passwordHash: passwordHash ?? (await hashPassword(password)),
      role: 'ADMIN',
    },
  });
}

async function upsertStaff(
  tx: Prisma.TransactionClient,
  facilityId: string,
): Promise<void> {
  const password = readNokyangDemoPassword(process.env);
  const existing = await tx.user.findUnique({
    where: { email: NOKYANG_STAFF_EMAIL },
    select: { passwordHash: true },
  });
  const passwordMatches =
    existing?.passwordHash != null
      ? await verifyPassword(password, existing.passwordHash)
      : false;
  const passwordHash = passwordMatches
    ? undefined
    : await hashPassword(password);
  await tx.user.upsert({
    where: { email: NOKYANG_STAFF_EMAIL },
    update: {
      facilityId,
      nickname: '녹양역점 요양보호사',
      role: 'STAFF',
      ...(passwordMatches
        ? {}
        : {
            passwordHash,
            sessionVersion: { increment: 1 },
          }),
    },
    create: {
      email: NOKYANG_STAFF_EMAIL,
      facilityId,
      id: 'user_nokyang_staff',
      nickname: '녹양역점 요양보호사',
      passwordHash: passwordHash ?? (await hashPassword(password)),
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

export async function seedNokyangDemo(): Promise<string> {
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

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
