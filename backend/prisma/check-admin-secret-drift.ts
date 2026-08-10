import type { PrismaClient } from '@prisma/client';

import { verifyPassword } from '../src/auth/password';
import {
  createManagedAdminPrismaClient,
  ManagedSuperAdminCollisionError,
  readSuperAdminConfig,
  type SuperAdminConfig,
} from './seed-super-admin';

export class ManagedSuperAdminDriftError extends Error {
  readonly name = 'ManagedSuperAdminDriftError';

  constructor() {
    super('Managed SUPER_ADMIN drift detected.');
  }
}

export async function assertManagedSuperAdminDriftFree(
  prisma: PrismaClient,
  config: SuperAdminConfig,
): Promise<void> {
  const managed = await prisma.user.findMany({
    where: { managedIdentityKey: { not: null } },
    select: {
      email: true,
      managedIdentityKey: true,
      passwordHash: true,
      role: true,
      facilityId: true,
    },
  });
  if (managed.length !== 1) throw new ManagedSuperAdminCollisionError();

  const [admin] = managed;
  const passwordMatches =
    admin.passwordHash !== null &&
    (await verifyPassword(config.password, admin.passwordHash));
  if (
    admin.managedIdentityKey !== config.managedIdentityKey ||
    admin.email !== config.email ||
    admin.role !== 'SUPER_ADMIN' ||
    admin.facilityId !== null ||
    !passwordMatches
  ) {
    throw new ManagedSuperAdminDriftError();
  }
}

async function main(): Promise<void> {
  const config = readSuperAdminConfig();
  const prisma = createManagedAdminPrismaClient();
  try {
    await assertManagedSuperAdminDriftFree(prisma, config);
    console.log(
      `Managed SUPER_ADMIN drift check passed managedKey=${config.managedIdentityKey}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : 'Managed SUPER_ADMIN drift check failed.',
    );
    process.exit(1);
  });
}
