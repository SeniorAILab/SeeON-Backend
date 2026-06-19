/**
 * Demo seed — creates one org with residents, cameras, guardians, and initial
 * ResidentStatus rows.
 *
 * Runs with the DIRECT_URL (fall superuser) to bypass RLS during setup.
 * Production ingest uses the same HMAC contract: per-camera HMAC-SHA256 secret,
 * only the hash is stored in the DB (never the plaintext secret).
 */
import { PrismaClient, ResidentState } from '@prisma/client';
import * as crypto from 'crypto';

// Suppress BigInt JSON serialisation errors in console.log
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
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
  const secret = fixed && fixed.length > 0 ? fixed : crypto.randomBytes(24).toString('hex');
  return { keyId, secret, hash: sha256(secret) };
}

async function main() {
  console.log('Seeding demo data…');

  // ── Organization ────────────────────────────────────────────────────────────
  const org = await prisma.organization.upsert({
    where: { id: 'demo-org-01' },
    update: { name: 'Demo Nursing Home' },
    create: {
      id: 'demo-org-01',
      name: 'Demo Nursing Home',
      businessRegistrationNumber: '123-45-67890',
    },
  });
  console.log(`Org: ${org.name} (${org.id})`);

  // ── Residents ───────────────────────────────────────────────────────────────
  const [resA, resB] = await Promise.all([
    prisma.resident.upsert({
      where: { orgId_id: { orgId: org.id, id: 'demo-res-01' } },
      update: {},
      create: { id: 'demo-res-01', orgId: org.id, name: '홍길동', room: '101호' },
    }),
    prisma.resident.upsert({
      where: { orgId_id: { orgId: org.id, id: 'demo-res-02' } },
      update: {},
      create: { id: 'demo-res-02', orgId: org.id, name: '이순신', room: '202호' },
    }),
  ]);
  console.log(`Residents: ${resA.name}, ${resB.name}`);

  // ── Cameras ─────────────────────────────────────────────────────────────────
  const cam1Keys = makeCameraSecret('Cam 01', process.env.DEMO_INGEST_SECRET);
  const cam2Keys = makeCameraSecret('Cam 02');

  const [cam1, cam2] = await Promise.all([
    prisma.camera.upsert({
      where: { orgId_id: { orgId: org.id, id: 'demo-cam-01' } },
      update: { ingestKeyId: cam1Keys.keyId, ingestSecretHash: cam1Keys.hash },
      create: {
        id: 'demo-cam-01',
        orgId: org.id,
        residentId: resA.id,
        label: 'Cam 01',
        ingestKeyId: cam1Keys.keyId,
        ingestSecretHash: cam1Keys.hash,
      },
    }),
    prisma.camera.upsert({
      where: { orgId_id: { orgId: org.id, id: 'demo-cam-02' } },
      update: { ingestKeyId: cam2Keys.keyId, ingestSecretHash: cam2Keys.hash },
      create: {
        id: 'demo-cam-02',
        orgId: org.id,
        residentId: resB.id,
        label: 'Cam 02',
        ingestKeyId: cam2Keys.keyId,
        ingestSecretHash: cam2Keys.hash,
      },
    }),
  ]);
  console.log(`Cameras: ${cam1.label} (keyId=${cam1.ingestKeyId}), ${cam2.label} (keyId=${cam2.ingestKeyId})`);

  // ── Guardians ───────────────────────────────────────────────────────────────
  await Promise.all([
    prisma.guardian.upsert({
      where: { id: 'demo-grd-01' },
      update: {},
      create: {
        id: 'demo-grd-01',
        orgId: org.id,
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
        orgId: org.id,
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
        orgId: org.id,
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
        orgId: org.id,
        state: ResidentState.NORMAL,
        cameraOnline: false,
        sourceId: cam2.id,
      },
    }),
  ]);
  console.log('ResidentStatus seeded');

  console.log('\nSeed complete.');
  console.log('Camera secrets (save these — they are not stored in DB):');
  console.log(`  ${cam1.label}: secret=${cam1Keys.secret}  keyId=${cam1Keys.keyId}`);
  console.log(`  ${cam2.label}: secret=${cam2Keys.secret}  keyId=${cam2Keys.keyId}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
