import { PrismaClient } from '@prisma/client';
import { verifyPassword } from '../src/auth/password';
import { NOKYANG_ADMIN_EMAIL } from '../prisma/demo-nokyang.fixture';
import { seedNokyangDemo } from '../prisma/seed';

const INITIAL_PASSWORD = 'seed-rotation-initial-password';
const ROTATED_PASSWORD = 'seed-rotation-rotated-password';

describe('Nokyang seeded admin password rotation', () => {
  let direct: PrismaClient;
  const originalPassword = process.env.NOKYANG_ADMIN_PASSWORD;

  beforeAll(async () => {
    if (!process.env.DIRECT_URL) {
      throw new Error('DIRECT_URL is required for seed admin rotation tests');
    }
    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    await direct.$connect();
  });

  afterAll(async () => {
    if (originalPassword === undefined) {
      delete process.env.NOKYANG_ADMIN_PASSWORD;
    } else {
      process.env.NOKYANG_ADMIN_PASSWORD = originalPassword;
    }
    await seedNokyangDemo();
    await direct.$disconnect();
  });

  it('rotates to the current environment secret and remains idempotently verifiable', async () => {
    process.env.NOKYANG_ADMIN_PASSWORD = INITIAL_PASSWORD;
    await seedNokyangDemo();
    const initialAdmin = await direct.user.findUniqueOrThrow({
      where: { email: NOKYANG_ADMIN_EMAIL },
      select: { passwordHash: true, sessionVersion: true },
    });

    expect(await verifyPassword(INITIAL_PASSWORD, initialAdmin.passwordHash ?? '')).toBe(
      true,
    );

    process.env.NOKYANG_ADMIN_PASSWORD = ROTATED_PASSWORD;
    await seedNokyangDemo();
    const rotatedAdmin = await direct.user.findUniqueOrThrow({
      where: { email: NOKYANG_ADMIN_EMAIL },
      select: { passwordHash: true, sessionVersion: true },
    });

    expect(await verifyPassword(ROTATED_PASSWORD, rotatedAdmin.passwordHash ?? '')).toBe(
      true,
    );
    expect(await verifyPassword(INITIAL_PASSWORD, rotatedAdmin.passwordHash ?? '')).toBe(
      false,
    );
    expect(rotatedAdmin.sessionVersion).toBe(initialAdmin.sessionVersion + 1);

    await seedNokyangDemo();
    const idempotentAdmin = await direct.user.findUniqueOrThrow({
      where: { email: NOKYANG_ADMIN_EMAIL },
      select: { passwordHash: true },
    });

    expect(await verifyPassword(ROTATED_PASSWORD, idempotentAdmin.passwordHash ?? '')).toBe(
      true,
    );
  });
});
