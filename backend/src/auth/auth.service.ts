import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KakaoClient, type KakaoProfile } from './kakao.client';
import { SessionService } from './session.service';

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
    const token = await this.kakao.exchangeCode(code);
    const profile = await this.kakao.getProfile(token.access_token);
    const user = await this.upsertUser(profile);
    const session = await this.sessions.createSession(user);
    return { user, token: session.token, maxAgeSeconds: session.maxAgeSeconds };
  }

  async createOrganizationForUser(
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
    if (existing.orgId) {
      const session = await this.sessions.createSession(existing);
      return {
        user: existing,
        token: session.token,
        maxAgeSeconds: session.maxAgeSeconds,
      };
    }

    const org = await this.prisma.db.organization.create({
      data: { name, businessRegistrationNumber },
    });

    const user = await this.prisma.withOrgContext(org.id, async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { orgId: org.id, role: 'OWNER' },
      });
      await tx.kakaoIdentity.upsert({
        where: { userId },
        update: { orgId: org.id, kakaoId: updated.kakaoId },
        create: { userId, orgId: org.id, kakaoId: updated.kakaoId },
      });
      return updated;
    });

    const session = await this.sessions.createSession(user);
    return { user, token: session.token, maxAgeSeconds: session.maxAgeSeconds };
  }

  private async upsertUser(profile: KakaoProfile): Promise<User> {
    return this.prisma.db.user.upsert({
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
  }
}
