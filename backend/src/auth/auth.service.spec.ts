import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthService } from './auth.service';
import type { KakaoClient } from './kakao.client';
import type { SessionService } from './session.service';
import { hashPassword } from './password';

describe('AuthService password login', () => {
  const makeService = (user: unknown) => {
    const prisma = {
      db: {
        user: {
          findFirst: jest.fn().mockResolvedValue(user),
        },
      },
    };
    const sessions = {
      createSession: jest.fn().mockResolvedValue({
        token: 'session-token',
        maxAgeSeconds: 1800,
      }),
    } as unknown as jest.Mocked<SessionService>;
    const service = new AuthService(
      prisma as never,
      {} as KakaoClient,
      sessions,
    );
    return { prisma, service, sessions };
  };

  it('creates the normal backend session for a valid email/password user', async () => {
    const passwordHash = await hashPassword('1234');
    const user = {
      id: 'user-1',
      facilityId: 'demo-facility-01',
      kakaoId: null,
      email: 'admin@sen.ai',
      passwordHash,
      nickname: '시설 관리자',
      role: 'ADMIN',
      sessionVersion: 0,
    };
    const { prisma, service, sessions } = makeService(user);

    const session = await service.loginWithPassword(' ADMIN@SEN.AI ', '1234');

    expect(prisma.db.user.findFirst).toHaveBeenCalledWith({
      where: { email: 'admin@sen.ai' },
    });
    expect(sessions.createSession.mock.calls[0]).toEqual([user]);
    expect(session).toEqual({
      user,
      token: 'session-token',
      maxAgeSeconds: 1800,
    });
  });

  it('rejects invalid credentials with a generic error', async () => {
    const passwordHash = await hashPassword('right-password');
    const { service, sessions } = makeService({
      id: 'user-1',
      email: 'admin@sen.ai',
      passwordHash,
    });

    await expect(
      service.loginWithPassword('admin@sen.ai', 'wrong-password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.createSession.mock.calls).toHaveLength(0);
  });
});

describe('AuthService password registration', () => {
  it('creates a facility owner and backend session for valid signup input', async () => {
    const facility = {
      id: 'facility-1',
      name: 'ULW 요양원',
      code: 'ulw',
      businessRegistrationNumber: null,
    };
    const user = {
      id: 'user-1',
      facilityId: facility.id,
      kakaoId: null,
      email: 'owner@example.test',
      passwordHash: 'hashed',
      phone: '010-1111-2222',
      nickname: '홍원장',
      role: 'ADMIN',
      sessionVersion: 0,
    };
    type UserCreateInput = {
      data: {
        facilityId: string;
        email: string;
        passwordHash: string;
        phone: string;
        nickname: string;
        role: 'ADMIN';
      };
    };
    type TransactionMock = {
      facility: {
        create: jest.Mock;
        findMany: jest.Mock;
      };
      user: {
        create: jest.Mock<Promise<typeof user>, [UserCreateInput]>;
      };
    };
    const createUser = jest.fn<Promise<typeof user>, [UserCreateInput]>(() =>
      Promise.resolve(user),
    );
    const tx: TransactionMock = {
      facility: {
        create: jest.fn().mockResolvedValue(facility),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        create: createUser,
      },
    };
    const prisma = {
      db: {
        user: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        facility: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        $transaction: jest.fn((callback: (tx: TransactionMock) => unknown) =>
          callback(tx),
        ),
      },
    };
    const sessions = {
      createSession: jest.fn().mockResolvedValue({
        token: 'session-token',
        maxAgeSeconds: 1800,
      }),
    } as unknown as jest.Mocked<SessionService>;
    const service = new AuthService(
      prisma as never,
      {} as KakaoClient,
      sessions,
    );

    const session = await service.registerWithPassword({
      name: ' 홍원장 ',
      email: ' OWNER@EXAMPLE.TEST ',
      password: 'care2026',
      phone: ' 010-1111-2222 ',
      facilityName: ' ULW 요양원 ',
    });

    expect(prisma.db.user.findFirst).toHaveBeenCalledWith({
      where: { email: 'owner@example.test' },
    });
    expect(tx.facility.create).toHaveBeenCalledWith({
      data: {
        name: 'ULW 요양원',
        code: 'ulw',
      },
    });
    const createdUserInput = createUser.mock.calls[0][0];
    expect(createdUserInput.data).toMatchObject({
      facilityId: facility.id,
      email: 'owner@example.test',
      phone: '010-1111-2222',
      nickname: '홍원장',
      role: 'ADMIN',
    });
    expect(createdUserInput.data.passwordHash.length).toBeGreaterThan(20);
    expect(sessions.createSession.mock.calls[0]).toEqual([user]);
    expect(session).toEqual({
      user,
      token: 'session-token',
      maxAgeSeconds: 1800,
    });
  });

  it('rejects missing required signup fields before creating records', async () => {
    const prisma = {
      db: {
        user: {
          findFirst: jest.fn(),
        },
        $transaction: jest.fn(),
      },
    };
    const sessions = {
      createSession: jest.fn(),
    } as unknown as jest.Mocked<SessionService>;
    const service = new AuthService(
      prisma as never,
      {} as KakaoClient,
      sessions,
    );

    await expect(
      service.registerWithPassword({
        name: '홍원장',
        email: 'owner@example.test',
        password: 'care2026',
        phone: '',
        facilityName: 'ULW 요양원',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.db.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.db.$transaction).not.toHaveBeenCalled();
    expect(sessions.createSession.mock.calls).toHaveLength(0);
  });

  it('rejects invalid signup email and weak password before creating records', async () => {
    const prisma = {
      db: {
        user: {
          findFirst: jest.fn(),
        },
        $transaction: jest.fn(),
      },
    };
    const sessions = {
      createSession: jest.fn(),
    } as unknown as jest.Mocked<SessionService>;
    const service = new AuthService(
      prisma as never,
      {} as KakaoClient,
      sessions,
    );

    await expect(
      service.registerWithPassword({
        name: '홍원장',
        email: 'not-an-email',
        password: 'care2026',
        phone: '010-1111-2222',
        facilityName: 'ULW 요양원',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.registerWithPassword({
        name: '홍원장',
        email: 'owner@example.test',
        password: '1234567',
        phone: '010-1111-2222',
        facilityName: 'ULW 요양원',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.registerWithPassword({
        name: '홍원장',
        email: 'owner@example.test',
        password: 'a'.repeat(129),
        phone: '010-1111-2222',
        facilityName: 'ULW 요양원',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.db.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.db.$transaction).not.toHaveBeenCalled();
    expect(sessions.createSession.mock.calls).toHaveLength(0);
  });

  it('retries facility code conflicts and only treats email uniqueness as duplicate signup', async () => {
    const firstFacilityConflict = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`code`)',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['code'] },
      },
    );
    const secondFacility = {
      id: 'facility-2',
      name: 'ULW 요양원',
      code: 'ulw-2',
      businessRegistrationNumber: null,
    };
    const user = {
      id: 'user-2',
      facilityId: secondFacility.id,
      kakaoId: null,
      email: 'owner2@example.test',
      passwordHash: 'hashed',
      phone: '010-1111-2222',
      nickname: '홍원장',
      role: 'ADMIN',
      sessionVersion: 0,
    };
    type FacilityCreateInput = {
      data: {
        name: string;
        code: string;
      };
    };
    type TransactionMock = {
      facility: {
        create: jest.Mock<
          Promise<typeof secondFacility>,
          [FacilityCreateInput]
        >;
      };
      user: {
        create: jest.Mock;
      };
    };
    const createFacility = jest.fn<
      Promise<typeof secondFacility>,
      [FacilityCreateInput]
    >();
    createFacility
      .mockRejectedValueOnce(firstFacilityConflict)
      .mockResolvedValue(secondFacility);
    const tx: TransactionMock = {
      facility: {
        create: createFacility,
      },
      user: {
        create: jest.fn().mockResolvedValue(user),
      },
    };
    const prisma = {
      db: {
        user: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        facility: {
          findMany: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ code: 'ulw' }]),
        },
        $transaction: jest.fn((callback: (tx: TransactionMock) => unknown) =>
          callback(tx),
        ),
      },
    };
    const sessions = {
      createSession: jest.fn().mockResolvedValue({
        token: 'session-token',
        maxAgeSeconds: 1800,
      }),
    } as unknown as jest.Mocked<SessionService>;
    const service = new AuthService(
      prisma as never,
      {} as KakaoClient,
      sessions,
    );

    const session = await service.registerWithPassword({
      name: '홍원장',
      email: 'owner2@example.test',
      password: 'care2026',
      phone: '010-1111-2222',
      facilityName: 'ULW 요양원',
    });

    expect(
      tx.facility.create.mock.calls.map((call) => call[0].data.code),
    ).toEqual(['ulw', 'ulw-2']);
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    expect(session.user).toBe(user);
  });

  it('maps email uniqueness conflicts to duplicate signup', async () => {
    const emailConflict = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`)',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['email'] },
      },
    );
    const tx = {
      facility: {
        create: jest.fn().mockResolvedValue({
          id: 'facility-1',
          name: 'ULW 요양원',
          code: 'ulw',
          businessRegistrationNumber: null,
        }),
      },
      user: {
        create: jest.fn().mockRejectedValue(emailConflict),
      },
    };
    const prisma = {
      db: {
        user: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        facility: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        $transaction: jest.fn((callback: (txArg: typeof tx) => unknown) =>
          callback(tx),
        ),
      },
    };
    const sessions = {
      createSession: jest.fn(),
    } as unknown as jest.Mocked<SessionService>;
    const service = new AuthService(
      prisma as never,
      {} as KakaoClient,
      sessions,
    );

    await expect(
      service.registerWithPassword({
        name: '홍원장',
        email: 'owner@example.test',
        password: 'care2026',
        phone: '010-1111-2222',
        facilityName: 'ULW 요양원',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(sessions.createSession.mock.calls).toHaveLength(0);
  });
});
