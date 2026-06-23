import { UnauthorizedException } from '@nestjs/common';
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
