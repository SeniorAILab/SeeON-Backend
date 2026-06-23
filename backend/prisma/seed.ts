/**
 * Demo seed — creates one facility with residents, cameras, guardians, and initial
 * ResidentStatus rows.
 *
 * Runs with the DIRECT_URL (fall superuser) to bypass RLS during setup.
 * Production ingest uses the same HMAC contract: per-camera HMAC-SHA256 secret,
 * only the hash is stored in the DB (never the plaintext secret).
 */
import { PrismaClient, ResidentState } from '@prisma/client';
import * as crypto from 'crypto';
import { hashPassword } from '../src/auth/password';

// Suppress BigInt JSON serialisation errors in console.log
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return BigInt.prototype.toString.call(this);
};

// Use privileged connection to bypass RLS during seed (NR3). Do not fall back
// to DATABASE_URL: the runtime app role must stay NOSUPERUSER/NOBYPASSRLS.
const directUrl = process.env.DIRECT_URL;
if (!directUrl) {
  console.error('DIRECT_URL must be set for privileged seed execution');
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url: directUrl } },
});

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ponytail: env override, random fallback. A fixed `DEMO_INGEST_SECRET` (set only
// in gitignored .env files, never committed) pins the demo camera secret so every
// reseed reproduces the same hash — the live Streamlit→Kakao demo keeps matching
// ml/.env's INGEST_SECRET. Unset → random per seed (the original behaviour).
function makeCameraSecret(
  label: string,
  fixed?: string,
): { keyId: string; secret: string; hash: string } {
  const keyId = `demo-${label.toLowerCase().replace(/\s+/g, '-')}-keyid`;
  const secret =
    fixed && fixed.length > 0 ? fixed : crypto.randomBytes(24).toString('hex');
  return { keyId, secret, hash: sha256(secret) };
}

async function main() {
  console.log('Seeding demo data…');

  // ── Facility ────────────────────────────────────────────────────────────
  const facility = await prisma.facility.upsert({
    where: { id: 'demo-facility-01' },
    update: { name: 'Demo Nursing Home', code: 'demo-nursing-home' },
    create: {
      id: 'demo-facility-01',
      name: 'Demo Nursing Home',
      code: 'demo-nursing-home',
      businessRegistrationNumber: '123-45-67890',
    },
  });
  console.log(`Facility: ${facility.name} (${facility.id})`);

  const demoLoginPassword = process.env.DEMO_LOGIN_PASSWORD ?? '1234';
  const demoPasswordHash = await hashPassword(demoLoginPassword);
  await Promise.all([
    prisma.user.upsert({
      where: { email: 'super@sen.ai' },
      update: {
        facilityId: null,
        nickname: '통합 관리자',
        passwordHash: demoPasswordHash,
        role: 'SUPER_ADMIN',
      },
      create: {
        id: 'demo-user-super',
        email: 'super@sen.ai',
        nickname: '통합 관리자',
        passwordHash: demoPasswordHash,
        role: 'SUPER_ADMIN',
      },
    }),
    prisma.user.upsert({
      where: { email: 'admin@sen.ai' },
      update: {
        facilityId: facility.id,
        nickname: '시설 관리자',
        passwordHash: demoPasswordHash,
        role: 'ADMIN',
      },
      create: {
        id: 'demo-user-admin',
        email: 'admin@sen.ai',
        facilityId: facility.id,
        nickname: '시설 관리자',
        passwordHash: demoPasswordHash,
        role: 'ADMIN',
      },
    }),
    prisma.user.upsert({
      where: { email: 'staff@sen.ai' },
      update: {
        facilityId: facility.id,
        nickname: '케어 직원',
        passwordHash: demoPasswordHash,
        role: 'CAREGIVER',
      },
      create: {
        id: 'demo-user-staff',
        email: 'staff@sen.ai',
        facilityId: facility.id,
        nickname: '케어 직원',
        passwordHash: demoPasswordHash,
        role: 'CAREGIVER',
      },
    }),
  ]);
  console.log('Demo login users seeded: super@sen.ai, admin@sen.ai, staff@sen.ai');

  const floor = await prisma.floor.upsert({
    where: { facilityId_name: { facilityId: facility.id, name: 'Demo Floor' } },
    update: {},
    create: {
      id: 'demo-floor-01',
      facilityId: facility.id,
      name: 'Demo Floor',
      orderIndex: 1,
    },
  });
  const [spaceA, spaceB] = await Promise.all([
    prisma.space.upsert({
      where: {
        facilityId_floorId_name: {
          facilityId: facility.id,
          floorId: floor.id,
          name: '101호',
        },
      },
      update: {},
      create: {
        id: 'demo-space-101',
        facilityId: facility.id,
        floorId: floor.id,
        name: '101호',
        type: 'ROOM',
        capacity: 1,
      },
    }),
    prisma.space.upsert({
      where: {
        facilityId_floorId_name: {
          facilityId: facility.id,
          floorId: floor.id,
          name: '202호',
        },
      },
      update: {},
      create: {
        id: 'demo-space-202',
        facilityId: facility.id,
        floorId: floor.id,
        name: '202호',
        type: 'ROOM',
        capacity: 1,
      },
    }),
  ]);

  // ── Residents ───────────────────────────────────────────────────────────────
  const [resA, resB] = await Promise.all([
    prisma.resident.upsert({
      where: { facilityId_id: { facilityId: facility.id, id: 'demo-res-01' } },
      update: {},
      create: {
        id: 'demo-res-01',
        facilityId: facility.id,
        name: '홍길동',
      },
    }),
    prisma.resident.upsert({
      where: { facilityId_id: { facilityId: facility.id, id: 'demo-res-02' } },
      update: {},
      create: {
        id: 'demo-res-02',
        facilityId: facility.id,
        name: '이순신',
      },
    }),
  ]);
  console.log(`Residents: ${resA.name}, ${resB.name}`);

  await Promise.all([
    prisma.residentAssignment.upsert({
      where: {
        facilityId_id: { facilityId: facility.id, id: 'demo-assignment-01' },
      },
      update: {},
      create: {
        id: 'demo-assignment-01',
        facilityId: facility.id,
        residentId: resA.id,
        spaceId: spaceA.id,
      },
    }),
    prisma.residentAssignment.upsert({
      where: {
        facilityId_id: { facilityId: facility.id, id: 'demo-assignment-02' },
      },
      update: {},
      create: {
        id: 'demo-assignment-02',
        facilityId: facility.id,
        residentId: resB.id,
        spaceId: spaceB.id,
      },
    }),
  ]);

  // ── Cameras ─────────────────────────────────────────────────────────────────
  const cam1Keys = makeCameraSecret('Cam 01', process.env.DEMO_INGEST_SECRET);
  const cam2Keys = makeCameraSecret('Cam 02');

  const [cam1, cam2] = await Promise.all([
    prisma.camera.upsert({
      where: { facilityId_id: { facilityId: facility.id, id: 'demo-cam-01' } },
      update: {
        ingestKeyId: cam1Keys.keyId,
        ingestSecretHash: cam1Keys.hash,
        spaceId: spaceA.id,
      },
      create: {
        id: 'demo-cam-01',
        facilityId: facility.id,
        spaceId: spaceA.id,
        label: 'Cam 01',
        ingestKeyId: cam1Keys.keyId,
        ingestSecretHash: cam1Keys.hash,
      },
    }),
    prisma.camera.upsert({
      where: { facilityId_id: { facilityId: facility.id, id: 'demo-cam-02' } },
      update: {
        ingestKeyId: cam2Keys.keyId,
        ingestSecretHash: cam2Keys.hash,
        spaceId: spaceB.id,
      },
      create: {
        id: 'demo-cam-02',
        facilityId: facility.id,
        spaceId: spaceB.id,
        label: 'Cam 02',
        ingestKeyId: cam2Keys.keyId,
        ingestSecretHash: cam2Keys.hash,
      },
    }),
  ]);
  console.log(
    `Cameras: ${cam1.label} (keyId=${cam1.ingestKeyId}), ${cam2.label} (keyId=${cam2.ingestKeyId})`,
  );

  // ── Guardians ───────────────────────────────────────────────────────────────
  await Promise.all([
    prisma.guardian.upsert({
      where: { id: 'demo-grd-01' },
      update: {},
      create: {
        id: 'demo-grd-01',
        facilityId: facility.id,
        residentId: resA.id,
        name: '홍보호자',
        phone: '010-****-1234',
        relation: '자녀',
      },
    }),
    prisma.guardian.upsert({
      where: { id: 'demo-grd-02' },
      update: {},
      create: {
        id: 'demo-grd-02',
        facilityId: facility.id,
        residentId: resB.id,
        name: '이보호자',
        phone: '010-****-5678',
        relation: '배우자',
      },
    }),
  ]);
  console.log('Guardians seeded');

  // ── ResidentStatus ───────────────────────────────────────────────────────────
  await Promise.all([
    prisma.residentStatus.upsert({
      where: { residentId: resA.id },
      update: {},
      create: {
        residentId: resA.id,
        facilityId: facility.id,
        state: ResidentState.NORMAL,
        cameraOnline: false,
        sourceId: cam1.id,
      },
    }),
    prisma.residentStatus.upsert({
      where: { residentId: resB.id },
      update: {},
      create: {
        residentId: resB.id,
        facilityId: facility.id,
        state: ResidentState.NORMAL,
        cameraOnline: false,
        sourceId: cam2.id,
      },
    }),
  ]);
  console.log('ResidentStatus seeded');

  console.log('\nSeed complete.');
  console.log('Camera secrets (save these — they are not stored in DB):');
  console.log(
    `  ${cam1.label}: secret=${cam1Keys.secret}  keyId=${cam1Keys.keyId}`,
  );
  console.log(
    `  ${cam2.label}: secret=${cam2Keys.secret}  keyId=${cam2Keys.keyId}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
