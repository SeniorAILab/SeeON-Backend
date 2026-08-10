import { Prisma, PrismaClient } from '@prisma/client';

import { hashPassword, verifyPassword } from '../src/auth/password';

export const MANAGED_SUPER_ADMIN_KEY = 'senior-ai-lab-primary' as const;

export type SuperAdminConfig = {
  readonly managedIdentityKey: typeof MANAGED_SUPER_ADMIN_KEY;
  readonly email: string;
  readonly password: string;
  readonly bootstrapSourceEmail: string;
};

type ManagedSuperAdmin = {
  readonly id: string;
  readonly email: string | null;
  readonly managedIdentityKey: string | null;
  readonly role: 'SUPER_ADMIN' | 'ADMIN' | 'STAFF';
  readonly passwordHash: string | null;
  readonly facilityId: string | null;
};

export type SuperAdminAction = 'update' | 'noop';

export class ManagedSuperAdminConfigError extends Error {
  readonly name = 'ManagedSuperAdminConfigError';
}

export class ManagedSuperAdminCollisionError extends Error {
  readonly name = 'ManagedSuperAdminCollisionError';

  constructor() {
    super('Managed SUPER_ADMIN identity collision; no rows changed.');
  }
}

export class ManagedSuperAdminSourceMissingError extends Error {
  readonly name = 'ManagedSuperAdminSourceMissingError';

  constructor() {
    super('Managed SUPER_ADMIN bootstrap source is missing; no rows changed.');
  }
}

export function readSuperAdminConfig(
  env: NodeJS.ProcessEnv = process.env,
): SuperAdminConfig {
  const managedIdentityKey = requiredInput(env, 'SUPER_ADMIN_MANAGED_KEY');
  if (managedIdentityKey !== MANAGED_SUPER_ADMIN_KEY) {
    throw new ManagedSuperAdminConfigError(
      `SUPER_ADMIN_MANAGED_KEY must be ${MANAGED_SUPER_ADMIN_KEY}.`,
    );
  }

  return {
    managedIdentityKey,
    email: requiredEmail(env, 'SUPER_ADMIN_EMAIL'),
    password: requiredInput(env, 'SUPER_ADMIN_PASSWORD', false),
    bootstrapSourceEmail: requiredEmail(
      env,
      'SUPER_ADMIN_BOOTSTRAP_SOURCE_EMAIL',
    ),
  };
}

export function decideSuperAdminAction(
  existing: ManagedSuperAdmin,
  passwordMatches: boolean,
  config: SuperAdminConfig,
): SuperAdminAction {
  return existing.email === config.email &&
    existing.managedIdentityKey === config.managedIdentityKey &&
    existing.role === 'SUPER_ADMIN' &&
    existing.facilityId === null &&
    passwordMatches
    ? 'noop'
    : 'update';
}

export async function bootstrapSuperAdmin(
  prisma: PrismaClient,
  config: SuperAdminConfig,
): Promise<SuperAdminAction> {
  return prisma.$transaction(
    async (transaction) => {
      const rows = await transaction.user.findMany({
        where: {
          OR: [
            { email: { in: [config.email, config.bootstrapSourceEmail] } },
            { managedIdentityKey: { not: null } },
          ],
        },
        select: {
          id: true,
          email: true,
          managedIdentityKey: true,
          role: true,
          passwordHash: true,
          facilityId: true,
        },
      });
      const existing = selectManagedSuperAdmin(rows, config);
      const passwordMatches =
        existing.passwordHash !== null &&
        (await verifyPassword(config.password, existing.passwordHash));
      const action = decideSuperAdminAction(existing, passwordMatches, config);
      if (action === 'noop') return action;

      await transaction.user.update({
        where: { id: existing.id },
        data: {
          email: config.email,
          managedIdentityKey: config.managedIdentityKey,
          role: 'SUPER_ADMIN',
          facilityId: null,
          sessionVersion: { increment: 1 },
          ...(passwordMatches
            ? {}
            : { passwordHash: await hashPassword(config.password) }),
        },
      });
      return action;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export function createManagedAdminPrismaClient(
  env: NodeJS.ProcessEnv = process.env,
): PrismaClient {
  const directUrl = env.DIRECT_URL;
  if (!directUrl) {
    throw new ManagedSuperAdminConfigError(
      'DIRECT_URL must be set for privileged managed SUPER_ADMIN access.',
    );
  }
  return new PrismaClient({ datasources: { db: { url: directUrl } } });
}

function selectManagedSuperAdmin(
  rows: readonly ManagedSuperAdmin[],
  config: SuperAdminConfig,
): ManagedSuperAdmin {
  const managedRows = rows.filter((row) => row.managedIdentityKey !== null);
  if (
    managedRows.length > 1 ||
    (managedRows.length === 1 &&
      managedRows[0].managedIdentityKey !== config.managedIdentityKey)
  ) {
    throw new ManagedSuperAdminCollisionError();
  }

  const managed = managedRows.find(
    (row) => row.managedIdentityKey === config.managedIdentityKey,
  );
  const existing =
    managed ?? rows.find((row) => row.email === config.bootstrapSourceEmail);
  if (!existing) throw new ManagedSuperAdminSourceMissingError();

  const target = rows.find((row) => row.email === config.email);
  if (target && target.id !== existing.id) {
    throw new ManagedSuperAdminCollisionError();
  }
  return existing;
}

function requiredInput(
  env: NodeJS.ProcessEnv,
  name: string,
  trim = true,
): string {
  const raw = env[name] ?? '';
  const value = trim ? raw.trim() : raw;
  if (value.length === 0) {
    throw new ManagedSuperAdminConfigError(`${name} must be set.`);
  }
  return value;
}

function requiredEmail(env: NodeJS.ProcessEnv, name: string): string {
  const email = requiredInput(env, name).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ManagedSuperAdminConfigError(`${name} must be a valid email.`);
  }
  return email;
}

async function main(): Promise<void> {
  const config = readSuperAdminConfig();
  const prisma = createManagedAdminPrismaClient();
  try {
    const action = await bootstrapSuperAdmin(prisma, config);
    console.log(
      `Managed SUPER_ADMIN bootstrap action=${action} managedKey=${config.managedIdentityKey}`,
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
        : 'Managed SUPER_ADMIN bootstrap failed.',
    );
    process.exit(1);
  });
}
