import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  KakaoClient,
  type KakaoProfile,
  type KakaoTokenResponse,
} from './kakao.client';
import { SessionService } from './session.service';
import { encryptToken } from './token-crypto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kakao: KakaoClient,
    private readonly sessions: SessionService,
  ) {}

  createOAuthState(): string {
    return randomBytes(24).toString('base64url');
  }

  getKakaoAuthorizeUrl(state: string): string {
    return this.kakao.buildAuthorizeUrl(state);
  }

  async completeKakaoCallback(
    code: string,
  ): Promise<{ user: User; token: string; maxAgeSeconds: number }> {
    if (!code)
      throw new BadRequestException('Missing Kakao authorization code');
    const kakaoToken = await this.kakao.exchangeCode(code);
    const profile = await this.kakao.getProfile(kakaoToken.access_token);
    const user = await this.upsertUser(profile, kakaoToken);
    const session = await this.sessions.createSession(user);
    return { user, token: session.token, maxAgeSeconds: session.maxAgeSeconds };
  }

  async createFacilityForUser(
    userId: string,
    facilityName: string,
    businessRegistrationNumber: string | null,
  ): Promise<{ user: User; token: string; maxAgeSeconds: number }> {
    const name = facilityName.trim();
    if (!name) throw new BadRequestException('facilityName is required');

    const existing = await this.prisma.db.user.findUnique({
      where: { id: userId },
    });
    if (!existing) throw new UnauthorizedException('Unknown user');
    if (existing.facilityId) {
      const session = await this.sessions.createSession(existing);
      return {
        user: existing,
        token: session.token,
        maxAgeSeconds: session.maxAgeSeconds,
      };
    }

    const facility = await this.prisma.db.facility.create({
      data: { name, businessRegistrationNumber },
    });

    const user = await this.prisma.withFacilityContext(
      facility.id,
      async (tx) => {
        const updated = await tx.user.update({
          where: { id: userId },
          data: { facilityId: facility.id, role: 'OWNER' },
        });
        await tx.kakaoIdentity.upsert({
          where: { userId },
          update: { facilityId: facility.id, kakaoId: updated.kakaoId },
          create: { userId, facilityId: facility.id, kakaoId: updated.kakaoId },
        });
        return updated;
      },
    );

    const session = await this.sessions.createSession(user);
    return { user, token: session.token, maxAgeSeconds: session.maxAgeSeconds };
  }

  private async upsertUser(
    profile: KakaoProfile,
    kakaoToken: KakaoTokenResponse,
  ): Promise<User> {
    const accessTokenCipher = encryptToken(kakaoToken.access_token);
    const tokenScope = kakaoToken.scope ?? this.kakao.resolveScopes();
    const tokenExpiresAt = kakaoToken.expires_in
      ? new Date(Date.now() + kakaoToken.expires_in * 1000)
      : null;

    return this.prisma.db.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { kakaoId: profile.kakaoId },
        update: {
          email: profile.email,
          nickname: profile.nickname,
        },
        create: {
          kakaoId: profile.kakaoId,
          email: profile.email,
          nickname: profile.nickname,
          role: 'OWNER',
        },
      });

      await tx.kakaoIdentity.upsert({
        where: { userId: user.id },
        update: {
          facilityId: user.facilityId,
          kakaoId: profile.kakaoId,
          accessTokenCipher,
          tokenScope,
          tokenExpiresAt,
        },
        create: {
          userId: user.id,
          facilityId: user.facilityId,
          kakaoId: profile.kakaoId,
          accessTokenCipher,
          tokenScope,
          tokenExpiresAt,
        },
      });

      return user;
    });
  }
}
