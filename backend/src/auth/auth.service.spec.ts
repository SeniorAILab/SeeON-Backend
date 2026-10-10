import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthService } from './services/auth.service';
import { hashPassword } from './password';
import { AuthRepository } from './repositories/auth.repository';
import { AuthUserNotFoundError } from './errors/auth-user-not-found.error';

function jwtMock() {
  return { sign: jest.fn(() => 'jwt-token') };
}

function config(ttl = '12h') {
  return new ConfigService({ JWT_TTL: ttl });
}

describe('AuthService JWT password login', () => {
  it('verifies scrypt password and signs pinned JWT claims', async () => {
    const passwordHash = await hashPassword('1234');
    const user = {
      id: 'user-1',
      facilityId: 'facility-1',
      email: 'admin@example.test',
      passwordHash,
      nickname: '관리자',
      role: 'ADMIN',
      sessionVersion: 7,
    };
    const prisma = {
      db: { user: { findFirst: jest.fn().mockResolvedValue(user) } },
    };
    const jwt = jwtMock();
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwt as never,
      config(),
    );

    const session = await service.loginWithPassword(
      ' ADMIN@example.TEST ',
      '1234',
    );

    expect(prisma.db.user.findFirst).toHaveBeenCalledWith({
      where: { email: 'admin@example.test' },
    });
    expect(jwt.sign).toHaveBeenCalledWith({
      sub: 'user-1',
      role: 'ADMIN',
      facilityId: 'facility-1',
      sessionVersion: 7,
    });
    expect(session).toEqual({
      user,
      token: 'jwt-token',
      maxAgeSeconds: 43_200,
    });
    expect(session.user).toBe(user);
  });

  it('rejects invalid credentials without signing a JWT', async () => {
    const passwordHash = await hashPassword('right-password');
    const prisma = {
      db: {
        user: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'user-1',
            email: 'admin@example.test',
            passwordHash,
          }),
        },
      },
    };
    const jwt = jwtMock();
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwt as never,
      config(),
    );

    await expect(
      service.loginWithPassword('admin@example.test', 'wrong-password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('bumps sessionVersion to revoke cookie JWTs on logout', async () => {
    const prisma = {
      db: { user: { update: jest.fn().mockResolvedValue({}) } },
    };
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwtMock() as never,
      config(),
    );

    await service.revokeAllSessions('user-1');

    expect(prisma.db.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { sessionVersion: { increment: 1 } },
    });
  });
});
describe('AuthService facility onboarding', () => {
  const unassignedUser = {
    id: 'user-1',
    facilityId: null,
    email: 'admin@example.test',
    nickname: '관리자',
    role: 'STAFF',
    sessionVersion: 0,
  };

  it('rolls back the new facility when assigning it to the user fails', async () => {
    let facilityCount = 0;
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
      user: {
        findUnique: jest.fn().mockResolvedValue(unassignedUser),
        update: jest.fn().mockRejectedValue(new Error('user update failed')),
      },
      facility: { create: jest.fn().mockResolvedValue({ id: 'facility-1' }) },
    };
    const prisma = {
      db: {
        user: { findUnique: jest.fn().mockResolvedValue(unassignedUser) },
        $transaction: jest.fn(
          async (callback: (client: typeof tx) => Promise<unknown>) => {
            const result = await callback(tx);
            facilityCount += 1;
            return result;
          },
        ),
      },
    };
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwtMock() as never,
      config(),
    );

    await expect(
      service.createFacilityForUser('user-1', '새 요양원'),
    ).rejects.toThrow('user update failed');

    expect(tx.facility.create).toHaveBeenCalledWith({
      data: { name: '새 요양원' },
    });
    expect(facilityCount).toBe(0);
  });

  it('returns the facility session found after the transaction lock without creating another facility', async () => {
    const assignedUser = {
      ...unassignedUser,
      facilityId: 'facility-existing',
      role: 'ADMIN',
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
      user: {
        findUnique: jest.fn().mockResolvedValue(assignedUser),
        update: jest.fn(),
      },
      facility: { create: jest.fn() },
    };
    const prisma = {
      db: {
        user: { findUnique: jest.fn().mockResolvedValue(unassignedUser) },
        $transaction: jest.fn(
          (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
        ),
      },
    };
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwtMock() as never,
      config(),
    );

    await expect(
      service.createFacilityForUser('user-1', '새 요양원'),
    ).resolves.toMatchObject({
      user: assignedUser,
      token: 'jwt-token',
    });

    expect(tx.facility.create).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('returns early for a user who already has a facility without starting a transaction', async () => {
    const assignedUser = {
      ...unassignedUser,
      facilityId: 'facility-existing',
      role: 'ADMIN',
    };
    const prisma = {
      db: {
        user: { findUnique: jest.fn().mockResolvedValue(assignedUser) },
        $transaction: jest.fn(),
      },
    };
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwtMock() as never,
      config(),
    );

    await expect(
      service.createFacilityForUser('user-1', '새 요양원'),
    ).resolves.toMatchObject({ user: assignedUser });

    expect(prisma.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('AuthService repository boundaries', () => {
  it('rejects the transaction with a domain error before mapping a missing locked user to 401', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      facility: { create: jest.fn() },
    };
    let committed = false;
    let transactionError: unknown;
    const prisma = {
      db: {
        user: { findUnique: jest.fn().mockResolvedValue({ facilityId: null }) },
        $transaction: jest.fn(
          async (callback: (client: typeof tx) => Promise<unknown>) => {
            try {
              const result = await callback(tx);
              committed = true;
              return result;
            } catch (error) {
              transactionError = error;
              throw error;
            }
          },
        ),
      },
    };
    const jwt = jwtMock();
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwt as never,
      config(),
    );
    const action = service.createFacilityForUser('user-1', ' Facility ');

    await expect(action).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(action).rejects.toMatchObject({
      message: 'Unknown user',
      status: 401,
      response: {
        message: 'Unknown user',
        error: 'Unauthorized',
        statusCode: 401,
      },
    });
    expect(transactionError).toBeInstanceOf(AuthUserNotFoundError);
    expect(committed).toBe(false);
    expect(tx.$queryRaw).toHaveBeenCalledWith(
      ['SELECT id FROM "users" WHERE id = ', ' FOR UPDATE'],
      'user-1',
    );
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
    });
    expect(tx.facility.create).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('preserves an unexpected transaction rejection instance', async () => {
    const failure = new Error('transaction unavailable');
    const prisma = {
      db: {
        user: { findUnique: jest.fn().mockResolvedValue({ facilityId: null }) },
        $transaction: jest.fn().mockRejectedValue(failure),
      },
    };
    const jwt = jwtMock();
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwt as never,
      config(),
    );

    await expect(
      service.createFacilityForUser('user-1', 'Facility'),
    ).rejects.toBe(failure);
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('returns dependency promises directly from repository methods', () => {
    const query = Promise.resolve(null);
    const transaction = Promise.resolve(null);
    const prisma = {
      db: {
        user: { findFirst: jest.fn(() => query) },
        $transaction: jest.fn(() => transaction),
      },
    };
    const repository = new AuthRepository(prisma as never);

    expect(repository.findByEmail('admin@example.test')).toBe(query);
    expect(repository.createFacilityForUser('user-1', 'Facility')).toBe(
      transaction,
    );
  });
});

describe('AuthService registration error boundary', () => {
  const input = {
    name: 'Owner',
    email: 'owner@example.test',
    password: 'Valid-password-123!',
    phone: '01012345678',
    facilityName: 'Facility',
  };

  it.each([
    { target: ['email'], conflict: true },
    { target: 'email', conflict: true },
    { target: ['phone', 'email'], conflict: true },
    { target: ['phone'], conflict: false },
    { target: 'user_email_key', conflict: false },
    { target: undefined, conflict: false },
    { target: null, conflict: false },
    { target: { email: true }, conflict: false },
  ])(
    'translates only exact email P2002 targets: $target',
    async ({ target, conflict }) => {
      const failure = new Prisma.PrismaClientKnownRequestError(
        'unique constraint',
        {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target },
        },
      );
      const prisma = {
        db: { user: { findFirst: jest.fn().mockResolvedValue(null) } },
      };
      const repository = new AuthRepository(prisma as never);
      // Isolate service translation; real helper coverage follows below.
      const create = jest
        .spyOn(repository, 'createRegisteredFacilityOwner')
        .mockRejectedValue(failure);
      const jwt = jwtMock();
      const service = new AuthService(repository, jwt as never, config());
      try {
        const action = service.registerWithPassword(input);
        if (conflict) {
          await expect(action).rejects.toBeInstanceOf(ConflictException);
          await expect(action).rejects.toMatchObject({
            message: 'Email already registered',
            status: 409,
          });
        } else {
          await expect(action).rejects.toBe(failure);
        }
        expect(create).toHaveBeenCalledTimes(1);
        expect(jwt.sign).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
      }
    },
  );

  it.each([
    new Error('registration unavailable'),
    new Prisma.PrismaClientKnownRequestError('record not found', {
      code: 'P2025',
      clientVersion: 'test',
      meta: { target: 'email' },
    }),
    { code: 'P2002', meta: { target: 'email' } },
  ])(
    'rethrows nonmatching registration errors unchanged: %p',
    async (failure) => {
      const prisma = {
        db: { user: { findFirst: jest.fn().mockResolvedValue(null) } },
      };
      const repository = new AuthRepository(prisma as never);
      const create = jest
        .spyOn(repository, 'createRegisteredFacilityOwner')
        .mockRejectedValue(failure);
      const jwt = jwtMock();
      const service = new AuthService(repository, jwt as never, config());
      try {
        await expect(service.registerWithPassword(input)).rejects.toBe(failure);
        expect(create).toHaveBeenCalledTimes(1);
        expect(jwt.sign).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
      }
    },
  );
});

describe('AuthService registration through the real repository helper', () => {
  const input = {
    name: ' Owner ',
    email: ' OWNER@EXAMPLE.TEST ',
    password: 'Valid-password-123!',
    phone: ' 01012345678 ',
    facilityName: ' Facility ',
  };

  function registrationPrisma(failure?: Error) {
    const state = {
      events: [] as string[],
      stagedFacilities: 0,
      committedFacilities: 0,
      rejection: undefined as unknown,
    };
    const user = {
      id: 'registered-user',
      facilityId: 'registered-facility',
      role: 'ADMIN',
      nickname: 'Owner',
      email: 'owner@example.test',
      sessionVersion: 0,
    };
    const tx = {
      facility: {
        create: jest.fn(() => {
          state.events.push('facility.create');
          state.stagedFacilities += 1;
          return Promise.resolve({ id: user.facilityId });
        }),
      },
      user: {
        create: jest.fn<
          Promise<typeof user>,
          [
            {
              data: {
                facilityId: string;
                email: string;
                passwordHash: string;
                phone: string;
                nickname: string;
                role: string;
              };
            },
          ]
        >(() => {
          state.events.push('user.create');
          return failure === undefined
            ? Promise.resolve(user)
            : Promise.reject(failure);
        }),
      },
    };
    const prisma = {
      db: {
        user: {
          findFirst: jest.fn(() => {
            state.events.push('user.findFirst');
            return Promise.resolve(null);
          }),
        },
        $transaction: jest.fn(
          async (callback: (client: typeof tx) => Promise<unknown>) => {
            state.events.push('transaction');
            try {
              const result = await callback(tx);
              state.committedFacilities += state.stagedFacilities;
              state.stagedFacilities = 0;
              state.events.push('commit');
              return result;
            } catch (error) {
              state.rejection = error;
              state.stagedFacilities = 0;
              state.events.push('rollback');
              throw error;
            }
          },
        ),
      },
    };
    return { prisma, tx, state, user };
  }

  it('creates the linked ADMIN after the precheck and returns the same user object', async () => {
    const { prisma, tx, state, user } = registrationPrisma();
    const jwt = jwtMock();
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwt as never,
      config(),
    );

    const session = await service.registerWithPassword(input);

    expect(prisma.db.user.findFirst).toHaveBeenCalledWith({
      where: { email: 'owner@example.test' },
    });
    expect(prisma.db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.facility.create).toHaveBeenCalledWith({
      data: { name: 'Facility' },
    });
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    const creation = tx.user.create.mock.calls.at(0);
    if (creation === undefined) throw new Error('Expected user creation');
    const passwordHash = creation[0].data.passwordHash;
    expect(typeof passwordHash).toBe('string');
    expect(passwordHash).not.toBe(input.password);
    expect(tx.user.create).toHaveBeenCalledWith({
      data: {
        facilityId: user.facilityId,
        email: 'owner@example.test',
        passwordHash,
        phone: '01012345678',
        nickname: 'Owner',
        role: 'ADMIN',
      },
    });
    expect(state.events).toEqual([
      'user.findFirst',
      'transaction',
      'facility.create',
      'user.create',
      'commit',
    ]);
    expect(state.committedFacilities).toBe(1);
    expect(session.user).toBe(user);
    expect(jwt.sign).toHaveBeenCalledWith({
      sub: user.id,
      role: 'ADMIN',
      facilityId: user.facilityId,
      sessionVersion: 0,
    });
  });

  it.each([
    {
      failure: new Prisma.PrismaClientKnownRequestError('email collision', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['email'] },
      }),
      conflict: true,
    },
    {
      failure: new Prisma.PrismaClientKnownRequestError('phone collision', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['phone'] },
      }),
      conflict: false,
    },
    { failure: new Error('insert failed'), conflict: false },
  ])(
    'observes helper transaction rejection before service mapping: $failure.message',
    async ({ failure, conflict }) => {
      const { prisma, tx, state } = registrationPrisma(failure);
      const jwt = jwtMock();
      const service = new AuthService(
        new AuthRepository(prisma as never),
        jwt as never,
        config(),
      );
      const action = service.registerWithPassword(input);

      if (conflict) {
        await expect(action).rejects.toBeInstanceOf(ConflictException);
        await expect(action).rejects.toMatchObject({
          message: 'Email already registered',
          status: 409,
          response: {
            message: 'Email already registered',
            error: 'Conflict',
            statusCode: 409,
          },
        });
      } else {
        await expect(action).rejects.toBe(failure);
      }
      expect(state.rejection).toBe(failure);
      expect(state.events).toEqual([
        'user.findFirst',
        'transaction',
        'facility.create',
        'user.create',
        'rollback',
      ]);
      expect(tx.facility.create).toHaveBeenCalledTimes(1);
      expect(tx.user.create).toHaveBeenCalledTimes(1);
      expect(state.stagedFacilities).toBe(0);
      expect(state.committedFacilities).toBe(0);
      expect(jwt.sign).not.toHaveBeenCalled();
    },
  );

  it('leaves email P2002 untouched at the direct repository boundary', async () => {
    const failure = new Prisma.PrismaClientKnownRequestError(
      'email collision',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: 'email' },
      },
    );
    const { prisma, tx, state } = registrationPrisma(failure);
    const repository = new AuthRepository(prisma as never);

    await expect(
      repository.createRegisteredFacilityOwner({
        facilityName: 'Facility',
        normalizedEmail: 'owner@example.test',
        passwordHash: 'already-hashed',
        phone: '01012345678',
        name: 'Owner',
      }),
    ).rejects.toBe(failure);
    expect(tx.user.create).toHaveBeenCalledWith({
      data: {
        facilityId: 'registered-facility',
        email: 'owner@example.test',
        passwordHash: 'already-hashed',
        phone: '01012345678',
        nickname: 'Owner',
        role: 'ADMIN',
      },
    });
    expect(state.rejection).toBe(failure);
    expect(state.events).toEqual([
      'transaction',
      'facility.create',
      'user.create',
      'rollback',
    ]);
    expect(state.committedFacilities).toBe(0);
    expect(prisma.db.user.findFirst).not.toHaveBeenCalled();
  });
});

describe('AuthService email-alert settings', () => {
  it('returns settings with effective email falling back to the login email', async () => {
    const prisma = {
      db: {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            notificationEmail: null,
            emailAlertsEnabled: true,
            email: 'admin@example.test',
          }),
        },
      },
    };
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwtMock() as never,
      config(),
    );

    await expect(service.getAlertSettings('user-1')).resolves.toEqual({
      notificationEmail: null,
      emailAlertsEnabled: true,
      effectiveEmail: 'admin@example.test',
    });
    expect(prisma.db.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: {
        notificationEmail: true,
        emailAlertsEnabled: true,
        email: true,
      },
    });
  });

  it('normalizes a new notification email and updates the flag', async () => {
    const prisma = {
      db: {
        user: {
          update: jest.fn().mockResolvedValue({
            notificationEmail: 'alerts@example.test',
            emailAlertsEnabled: false,
            email: 'admin@example.test',
          }),
        },
      },
    };
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwtMock() as never,
      config(),
    );

    const result = await service.updateAlertSettings('user-1', {
      notificationEmail: ' Alerts@Example.TEST ',
      emailAlertsEnabled: false,
    });

    expect(prisma.db.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        notificationEmail: 'alerts@example.test',
        emailAlertsEnabled: false,
      },
      select: {
        notificationEmail: true,
        emailAlertsEnabled: true,
        email: true,
      },
    });
    expect(result.notificationEmail).toBe('alerts@example.test');
    expect(result.emailAlertsEnabled).toBe(false);
  });

  it('clears the notification email when given a blank value', async () => {
    const prisma = {
      db: {
        user: {
          update: jest.fn().mockResolvedValue({
            notificationEmail: null,
            emailAlertsEnabled: true,
            email: 'admin@example.test',
          }),
        },
      },
    };
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwtMock() as never,
      config(),
    );

    await service.updateAlertSettings('user-1', { notificationEmail: '   ' });

    expect(prisma.db.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { notificationEmail: null },
      select: {
        notificationEmail: true,
        emailAlertsEnabled: true,
        email: true,
      },
    });
  });

  it('rejects an invalid notification email without updating', async () => {
    const prisma = { db: { user: { update: jest.fn() } } };
    const service = new AuthService(
      new AuthRepository(prisma as never),
      jwtMock() as never,
      config(),
    );

    await expect(
      service.updateAlertSettings('user-1', {
        notificationEmail: 'not-an-email',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.db.user.update).not.toHaveBeenCalled();
  });
});
