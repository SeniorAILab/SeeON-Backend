import type { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { AuthService } from './auth.service';
import {
  RBAC_PERMISSIONS,
  hasRbacCapability,
  isAuthRole,
  postLoginPathForUser,
} from './auth.constants';
import type { KakaoClient } from './kakao.client';
import { SessionService } from './session.service';

describe('RBAC SSOT', () => {
  beforeEach(() => {
    process.env.KAKAO_TOKEN_ENC_KEY = '0'.repeat(64);
  });
  it('defines the exact three backend roles and capability matrix', () => {
    expect(isAuthRole(Role.SUPER_ADMIN)).toBe(true);
    expect(isAuthRole(Role.ADMIN)).toBe(true);
    expect(isAuthRole(Role.STAFF)).toBe(true);
    expect(hasRbacCapability(Role.SUPER_ADMIN, 'personalLogin')).toBe(true);
    expect(hasRbacCapability(Role.ADMIN, 'personalLogin')).toBe(true);
    expect(hasRbacCapability(Role.STAFF, 'personalLogin')).toBe(true);
    expect(hasRbacCapability(Role.STAFF, 'monitorView')).toBe(true);
    expect(RBAC_PERMISSIONS[Role.STAFF].has('facilityAdmin')).toBe(false);
    expect(
      postLoginPathForUser({ role: Role.SUPER_ADMIN, facilityId: null }),
    ).toBe('/dashboard');
    expect(
      postLoginPathForUser({ role: Role.ADMIN, facilityId: 'fac 1' }),
    ).toBe('/dashboard/facilities/fac%201/admin');
    expect(
      postLoginPathForUser({ role: Role.STAFF, facilityId: 'fac-1' }),
    ).toBe('/dashboard/facilities/fac-1/staff');
  });

  it('creates personal sessions for staff users', async () => {
    const prisma = {
      db: {
        serverSession: {
          create: jest.fn().mockResolvedValue({
            id: 'session-1',
            userId: 'user-1',
            facilityId: 'facility-1',
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
          }),
        },
      },
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'SESSION_JWT_SECRET' ? 'x'.repeat(32) : undefined,
      ),
    } as unknown as ConfigService;
    const service = new SessionService(prisma as never, config);

    const session = await service.createSession({
      id: 'user-1',
      facilityId: 'facility-1',
      role: 'STAFF',
      kakaoId: 'kakao-1',
      nickname: 'Staff',
      sessionVersion: 0,
    });

    expect(typeof session.token).toBe('string');
    expect(typeof session.maxAgeSeconds).toBe('number');
    expect(prisma.db.serverSession.create).toHaveBeenCalled();
  });

  it('updates only existing Kakao-linked users during Kakao login', async () => {
    const existingUser = {
      id: 'user-1',
      kakaoId: 'kakao-1',
      email: 'old@example.test',
      nickname: 'Old',
      role: 'STAFF',
      facilityId: 'facility-1',
      sessionVersion: 0,
    };
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue(existingUser),
        update: jest.fn().mockResolvedValue({
          ...existingUser,
          email: 'a@example.test',
          nickname: 'Staff',
        }),
      },
      kakaoIdentity: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      db: {
        $transaction: jest.fn((fn: (arg: typeof tx) => unknown) => fn(tx)),
      },
    };
    const service = new AuthService(
      prisma as never,
      {
        resolveScopes: jest.fn().mockReturnValue('talk_message'),
      } as unknown as KakaoClient,
      {} as never,
    );

    await (
      service as unknown as {
        updateLinkedKakaoUser: (
          profile: { kakaoId: string; email: string; nickname: string },
          token: { access_token: string; expires_in: number; scope?: string },
        ) => Promise<unknown>;
      }
    ).updateLinkedKakaoUser(
      { kakaoId: 'kakao-1', email: 'a@example.test', nickname: 'Staff' },
      { access_token: 'token', expires_in: 3600 },
    );

    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { kakaoId: 'kakao-1' },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        email: 'a@example.test',
        nickname: 'Staff',
      },
    });
  });
});
