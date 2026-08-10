import {
  createManagedAdminPrismaClient,
  readSuperAdminConfig,
} from '../../prisma/seed-super-admin';

const MANAGED_KEY = 'senior-ai-lab-primary';
const SOURCE_EMAIL = 'previous-admin@example.test';
const TARGET_EMAIL = 'managed-admin@example.test';
const PASSWORD = 'fixture-password';

const MANAGED_ENV = {
  SUPER_ADMIN_MANAGED_KEY: MANAGED_KEY,
  SUPER_ADMIN_EMAIL: TARGET_EMAIL,
  SUPER_ADMIN_PASSWORD: PASSWORD,
  SUPER_ADMIN_BOOTSTRAP_SOURCE_EMAIL: SOURCE_EMAIL,
};

describe('managed super-admin bootstrap config', () => {
  it('parses exactly the four managed identity inputs', () => {
    expect(
      readSuperAdminConfig({
        ...MANAGED_ENV,
        SUPER_ADMIN_NICKNAME: 'must-be-ignored',
        SUPER_ADMIN_FACILITY_ID: 'must-be-ignored',
      }),
    ).toEqual({
      managedIdentityKey: MANAGED_KEY,
      email: TARGET_EMAIL,
      password: PASSWORD,
      bootstrapSourceEmail: SOURCE_EMAIL,
    });
  });

  it.each([
    'SUPER_ADMIN_MANAGED_KEY',
    'SUPER_ADMIN_EMAIL',
    'SUPER_ADMIN_PASSWORD',
    'SUPER_ADMIN_BOOTSTRAP_SOURCE_EMAIL',
  ] as const)('fails closed when %s is absent', (missingKey) => {
    const env = { ...MANAGED_ENV };
    delete env[missingKey];

    expect(() => readSuperAdminConfig(env)).toThrow(missingKey);
  });

  it('rejects a managed key other than the immutable product key', () => {
    expect(() =>
      readSuperAdminConfig({
        ...MANAGED_ENV,
        SUPER_ADMIN_MANAGED_KEY: 'another-managed-key',
      }),
    ).toThrow(MANAGED_KEY);
  });

  it('normalizes identity emails without trimming the password', () => {
    expect(
      readSuperAdminConfig({
        ...MANAGED_ENV,
        SUPER_ADMIN_EMAIL: `  ${TARGET_EMAIL.toUpperCase()}  `,
        SUPER_ADMIN_BOOTSTRAP_SOURCE_EMAIL: `  ${SOURCE_EMAIL.toUpperCase()}  `,
        SUPER_ADMIN_PASSWORD: ` ${PASSWORD} `,
      }),
    ).toEqual({
      managedIdentityKey: MANAGED_KEY,
      email: TARGET_EMAIL,
      password: ` ${PASSWORD} `,
      bootstrapSourceEmail: SOURCE_EMAIL,
    });
  });

  it('requires direct database access before privileged reconciliation', () => {
    expect(() => createManagedAdminPrismaClient({})).toThrow('DIRECT_URL');
  });
});
