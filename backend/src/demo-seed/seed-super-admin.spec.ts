import { hashPassword } from '../auth/password';
import {
  bootstrapSuperAdmin,
  decideSuperAdminAction,
  readSuperAdminConfig,
  type ExistingSuperAdmin,
  type SuperAdminPrisma,
} from '../../prisma/seed-super-admin';

describe('super-admin bootstrap config', () => {
  it('skips when SUPER_ADMIN_PASSWORD is unset or empty', () => {
    expect(readSuperAdminConfig({})).toEqual({
      skip: true,
      reason: 'SUPER_ADMIN_PASSWORD is not set',
    });
    expect(readSuperAdminConfig({ SUPER_ADMIN_PASSWORD: '' })).toEqual({
      skip: true,
      reason: 'SUPER_ADMIN_PASSWORD is not set',
    });
  });

  it('defaults email/nickname to the canonical super admin when only the password is set', () => {
    expect(readSuperAdminConfig({ SUPER_ADMIN_PASSWORD: 'pw' })).toEqual({
      skip: false,
      email: '<REDACTED_NOTIFICATION_EMAIL>',
      password: 'pw',
      nickname: 'SeniorAILab Super Admin',
      facilityId: null,
    });
  });

  it('uses and trims explicit overrides', () => {
    expect(
      readSuperAdminConfig({
        SUPER_ADMIN_PASSWORD: 'pw',
        SUPER_ADMIN_EMAIL: '  admin@example.com  ',
        SUPER_ADMIN_NICKNAME: '  Boss  ',
        SUPER_ADMIN_FACILITY_ID: '  fac_happy_nokyang  ',
      }),
    ).toEqual({
      skip: false,
      email: 'admin@example.com',
      password: 'pw',
      nickname: 'Boss',
      facilityId: 'fac_happy_nokyang',
    });
  });
});

describe('super-admin action decision', () => {
  it('creates when no user exists', () => {
    expect(decideSuperAdminAction(null, false)).toBe('create');
  });

  it('no-ops only when already SUPER_ADMIN with a matching password', () => {
    expect(
      decideSuperAdminAction(
        { id: 'u1', role: 'SUPER_ADMIN', passwordHash: 'hash' },
        true,
      ),
    ).toBe('noop');
  });

  it('updates an existing non-super-admin or a password mismatch', () => {
    const cases: { existing: ExistingSuperAdmin; matches: boolean }[] = [
      {
        existing: { id: 'u1', role: 'ADMIN', passwordHash: 'hash' },
        matches: true,
      },
      {
        existing: { id: 'u1', role: 'SUPER_ADMIN', passwordHash: 'hash' },
        matches: false,
      },
      {
        existing: { id: 'u1', role: 'SUPER_ADMIN', passwordHash: null },
        matches: false,
      },
    ];
    for (const { existing, matches } of cases) {
      expect(decideSuperAdminAction(existing, matches)).toBe('update');
    }
  });
});

describe('bootstrapSuperAdmin wiring', () => {
  const config = {
    skip: false as const,
    email: '<REDACTED_NOTIFICATION_EMAIL>',
    password: 's3cret-pass',
    nickname: 'SeniorAILab Super Admin',
    facilityId: null,
  };

  function makePrisma(existing: ExistingSuperAdmin): {
    prisma: SuperAdminPrisma;
    create: jest.Mock;
    update: jest.Mock;
  } {
    const create = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    const prisma: SuperAdminPrisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create,
        update,
      },
    };
    return { prisma, create, update };
  }

  it('creates a SUPER_ADMIN when the account is absent', async () => {
    const { prisma, create, update } = makePrisma(null);
    await expect(bootstrapSuperAdmin(prisma, config)).resolves.toBe('create');
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const [arg] = create.mock.calls[0] as [
      Parameters<SuperAdminPrisma['user']['create']>[0],
    ];
    expect(arg.data.email).toBe(config.email);
    expect(arg.data.role).toBe('SUPER_ADMIN');
    expect(arg.data.nickname).toBe(config.nickname);
    expect(arg.data.passwordHash).toMatch(/^scrypt\$/);
  });

  it('promotes and resets an existing ADMIN, bumping sessionVersion', async () => {
    const { prisma, create, update } = makePrisma({
      id: 'user_nokyang_admin',
      role: 'ADMIN',
      passwordHash: await hashPassword('old-password'),
    });
    await expect(bootstrapSuperAdmin(prisma, config)).resolves.toBe('update');
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const [arg] = update.mock.calls[0] as [
      Parameters<SuperAdminPrisma['user']['update']>[0],
    ];
    expect(arg.where).toEqual({ id: 'user_nokyang_admin' });
    expect(arg.data.role).toBe('SUPER_ADMIN');
    expect(arg.data.sessionVersion).toEqual({ increment: 1 });
    expect(arg.data.passwordHash).toMatch(/^scrypt\$/);
  });

  it('is a no-op when the SUPER_ADMIN password already matches', async () => {
    const { prisma, create, update } = makePrisma({
      id: 'user_nokyang_admin',
      role: 'SUPER_ADMIN',
      passwordHash: await hashPassword(config.password),
    });
    await expect(bootstrapSuperAdmin(prisma, config)).resolves.toBe('noop');
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
