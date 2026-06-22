import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import {
  BACKEND_ROLES,
  RBAC_PERMISSIONS,
  hasRbacCapability,
} from './auth.constants';
import type { KakaoClient } from './kakao.client';
import { SessionService } from './session.service';

describe('RBAC SSOT', () => {
  beforeEach(() => {
    process.env.KAKAO_TOKEN_ENC_KEY = '0'.repeat(64);
  });
  it('defines the exact three backend roles and capability matrix', () => {
    expect(BACKEND_ROLES).toEqual(['SUPER_ADMIN', 'ADMIN', 'CAREGIVER']);
    expect(hasRbacCapability('SUPER_ADMIN', 'personalLogin')).toBe(true);
    expect(hasRbacCapability('ADMIN', 'personalLogin')).toBe(true);
    expect(hasRbacCapability('CAREGIVER', 'personalLogin')).toBe(false);
    expect(hasRbacCapability('CAREGIVER', 'monitorView')).toBe(true);
    expect(RBAC_PERMISSIONS.CAREGIVER.has('facilityAdmin')).toBe(false);
  });

  it('does not create personal sessions for CAREGIVER', async () => {
    const prisma = {
      db: { serverSession: { create: jest.fn() } },
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'SESSION_JWT_SECRET' ? 'x'.repeat(32) : undefined,
      ),
    } as unknown as ConfigService;
    const service = new SessionService(prisma as never, config);

    await expect(
      service.createSession({
        id: 'user-1',
        facilityId: 'facility-1',
        role: 'CAREGIVER',
        kakaoId: 'kakao-1',
        nickname: 'Caregiver',
        sessionVersion: 0,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.db.serverSession.create).not.toHaveBeenCalled();
  });

  it('onboards Kakao users as ADMIN, not legacy OWNER', async () => {
    const tx = {
      user: {
        upsert: jest.fn().mockResolvedValue({
          id: 'user-1',
          kakaoId: 'kakao-1',
          email: 'a@example.test',
          nickname: 'Admin',
          role: 'ADMIN',
          facilityId: null,
          sessionVersion: 0,
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
        upsertUser: (
          profile: { kakaoId: string; email: string; nickname: string },
          token: { access_token: string; expires_in: number; scope?: string },
        ) => Promise<unknown>;
      }
    ).upsertUser(
      { kakaoId: 'kakao-1', email: 'a@example.test', nickname: 'Admin' },
      { access_token: 'token', expires_in: 3600 },
    );

    expect(tx.user.upsert).toHaveBeenCalledWith({
      where: { kakaoId: 'kakao-1' },
      update: {
        email: 'a@example.test',
        nickname: 'Admin',
      },
      create: {
        kakaoId: 'kakao-1',
        email: 'a@example.test',
        nickname: 'Admin',
        role: 'ADMIN',
      },
    });
  });
});
