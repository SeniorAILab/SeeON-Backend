import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { hashPassword } from './password';

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
    const service = new AuthService(prisma as never, jwt as never, config());

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
    const service = new AuthService(prisma as never, jwt as never, config());

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
      prisma as never,
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
