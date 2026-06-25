import {
  BadRequestException,
  ConflictException,
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
import { hashPassword, verifyPassword } from './password';
import { assertValidPassword, requiredPassword } from './password-policy';
import { createRegisteredFacilityOwner } from './password-registration';
import { nextFacilityCode } from './facility-code';

export interface RegisterWithPasswordInput {
  readonly name: unknown;
  readonly email: unknown;
  readonly password: unknown;
  readonly phone: unknown;
  readonly facilityName: unknown;
}

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
    const user = await this.updateLinkedKakaoUser(profile, kakaoToken);
    const session = await this.sessions.createSession(user);
    return { user, token: session.token, maxAgeSeconds: session.maxAgeSeconds };
  }

  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<{ user: User; token: string; maxAgeSeconds: number }> {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const user = await this.prisma.db.user.findFirst({
      where: { email: normalizedEmail },
    });
    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const passwordMatches = await verifyPassword(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const session = await this.sessions.createSession(user);
    return { user, token: session.token, maxAgeSeconds: session.maxAgeSeconds };
  }

  async registerWithPassword(
    input: RegisterWithPasswordInput,
  ): Promise<{ user: User; token: string; maxAgeSeconds: number }> {
    const name = requiredString(input.name, 'name');
    const normalizedEmail = normalizeEmail(
      requiredString(input.email, 'email'),
    );
    const password = requiredPassword(input.password);
    assertValidPassword(password);
    const phone = requiredString(input.phone, 'phone');
    const facilityName = requiredString(input.facilityName, 'facilityName');

    const existing = await this.prisma.db.user.findFirst({
      where: { email: normalizedEmail },
    });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await hashPassword(password);
    const user = await createRegisteredFacilityOwner(this.prisma, {
      facilityName,
      normalizedEmail,
      passwordHash,
      phone,
      name,
    });

    const session = await this.sessions.createSession(user);
    return { user, token: session.token, maxAgeSeconds: session.maxAgeSeconds };
  }

  async createFacilityForUser(
    userId: string,
    facilityName: string,
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
      data: {
        name,
        code: await nextFacilityCode(this.prisma, name),
      },
    });

    const user = await this.prisma.withFacilityContext(
      facility.id,
      async (tx) => {
        const updated = await tx.user.update({
          where: { id: userId },
          data: { facilityId: facility.id, role: 'ADMIN' },
        });
        if (updated.kakaoId) {
          await tx.kakaoIdentity.upsert({
            where: { userId },
            update: { facilityId: facility.id, kakaoId: updated.kakaoId },
            create: {
              userId,
              facilityId: facility.id,
              kakaoId: updated.kakaoId,
            },
          });
        }
        return updated;
      },
    );

    const session = await this.sessions.createSession(user);
    return { user, token: session.token, maxAgeSeconds: session.maxAgeSeconds };
  }

  private async updateLinkedKakaoUser(
    profile: KakaoProfile,
    kakaoToken: KakaoTokenResponse,
  ): Promise<User> {
    const accessTokenCipher = encryptToken(kakaoToken.access_token);
    const tokenScope = kakaoToken.scope ?? this.kakao.resolveScopes();
    const tokenExpiresAt = kakaoToken.expires_in
      ? new Date(Date.now() + kakaoToken.expires_in * 1000)
      : null;

    return this.prisma.db.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { kakaoId: profile.kakaoId },
      });
      if (!existing) {
        throw new UnauthorizedException('Kakao account is not registered');
      }

      const user = await tx.user.update({
        where: { id: existing.id },
        data: {
          email: profile.email,
          nickname: profile.nickname,
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

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new BadRequestException('email must be valid');
  }
  return normalized;
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new BadRequestException(`${fieldName} is required`);
  return trimmed;
}
