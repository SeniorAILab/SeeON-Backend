import type { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import {
  AUTH_ROLES,
  RBAC_PERMISSIONS,
  hasRbacCapability,
  postLoginPathForRole,
} from './auth.constants';
import type { KakaoClient } from './kakao.client';
import { SessionService } from './session.service';

describe('RBAC SSOT', () => {
  beforeEach(() => {
    process.env.KAKAO_TOKEN_ENC_KEY = '0'.repeat(64);
  });
  it('defines the exact three backend roles and capability matrix', () => {
    expect(AUTH_ROLES).toEqual(['SUPER_ADMIN', 'ADMIN', 'STAFF']);
    expect(hasRbacCapability('SUPER_ADMIN', 'personalLogin')).toBe(true);
    expect(hasRbacCapability('ADMIN', 'personalLogin')).toBe(true);
    expect(hasRbacCapability('STAFF', 'personalLogin')).toBe(true);
    expect(hasRbacCapability('STAFF', 'monitorView')).toBe(true);
    expect(RBAC_PERMISSIONS.STAFF.has('facilityAdmin')).toBe(false);
    expect(postLoginPathForRole('SUPER_ADMIN')).toBe('/admin/dashboard');
    expect(postLoginPathForRole('ADMIN')).toBe('/admin/dashboard');
    expect(postLoginPathForRole('STAFF')).toBe('/now');
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
