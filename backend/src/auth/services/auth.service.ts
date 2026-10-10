import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { isUniqueConstraintViolation } from '../../common/errors';
import { AuthRepository } from '../repositories/auth.repository';
import { AuthUserNotFoundError } from '../errors/auth-user-not-found.error';
import { hashPassword, verifyPassword } from '../password';
import {
  assertValidPassword,
  requiredPassword,
} from './password-policy.service';
import { DEFAULT_JWT_TTL, hasRbacCapability } from '../auth.constants';

export interface AuthSession {
  readonly user: Pick<
    User,
    'id' | 'facilityId' | 'role' | 'nickname' | 'email' | 'sessionVersion'
  >;
  readonly token: string;
  readonly maxAgeSeconds: number;
}

export interface AlertSettings {
  readonly notificationEmail: string | null;
  readonly emailAlertsEnabled: boolean;
  readonly effectiveEmail: string | null;
}

export interface UpdateAlertSettingsInput {
  readonly notificationEmail?: string | null;
  readonly emailAlertsEnabled?: boolean;
}

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
    private readonly repository: AuthRepository,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<AuthSession> {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const user = await this.repository.findByEmail(normalizedEmail);
    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const passwordMatches = await verifyPassword(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.createJwtSession(user);
  }

  async registerWithPassword(
    input: RegisterWithPasswordInput,
  ): Promise<AuthSession> {
    const name = requiredString(input.name, 'name');
    const normalizedEmail = normalizeEmail(
      requiredString(input.email, 'email'),
    );
    const password = requiredPassword(input.password);
    assertValidPassword(password);
    const phone = requiredString(input.phone, 'phone');
    const facilityName = requiredString(input.facilityName, 'facilityName');

    const existing = await this.repository.findByEmail(normalizedEmail);
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await hashPassword(password);
    let user: User;
    try {
      user = await this.repository.createRegisteredFacilityOwner({
        facilityName,
        normalizedEmail,
        passwordHash,
        phone,
        name,
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        const target = error.meta?.target;
        if (
          Array.isArray(target) ? target.includes('email') : target === 'email'
        ) {
          throw new ConflictException('Email already registered');
        }
      }
      throw error;
    }

    return this.createJwtSession(user);
  }

  async createFacilityForUser(
    userId: string,
    facilityName: string,
  ): Promise<AuthSession> {
    const name = facilityName.trim();
    if (!name) throw new BadRequestException('facilityName is required');

    const existing = await this.repository.findById(userId);
    if (!existing) throw new UnauthorizedException('Unknown user');
    if (existing.facilityId) {
      return this.createJwtSession(existing);
    }

    let user: User;
    try {
      user = await this.repository.createFacilityForUser(userId, name);
    } catch (error) {
      if (error instanceof AuthUserNotFoundError) {
        throw new UnauthorizedException('Unknown user');
      }
      throw error;
    }

    return this.createJwtSession(user);
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.repository.incrementSessionVersion(userId);
  }

  async isSessionVersionCurrent(
    userId: string,
    expectedSessionVersion: number,
  ): Promise<boolean> {
    const user = await this.repository.findSessionVersion(userId);
    return user !== null && user.sessionVersion === expectedSessionVersion;
  }

  private createJwtSession(
    user: Pick<
      User,
      'id' | 'facilityId' | 'role' | 'nickname' | 'email' | 'sessionVersion'
    >,
  ): AuthSession {
    if (!hasRbacCapability(user.role, 'personalLogin')) {
      throw new UnauthorizedException('Role cannot create a personal session');
    }
    const expiresIn = this.jwtTtl();
    const token = this.jwt.sign({
      sub: user.id,
      role: user.role,
      facilityId: user.facilityId,
      sessionVersion: user.sessionVersion,
    });
    return { user, token, maxAgeSeconds: jwtTtlSeconds(expiresIn) };
  }

  async getAlertSettings(userId: string): Promise<AlertSettings> {
    const user = await this.repository.findAlertSettings(userId);
    if (!user) throw new UnauthorizedException('Unknown user');
    return {
      notificationEmail: user.notificationEmail,
      emailAlertsEnabled: user.emailAlertsEnabled,
      effectiveEmail: user.notificationEmail ?? user.email,
    };
  }

  async updateAlertSettings(
    userId: string,
    input: UpdateAlertSettingsInput,
  ): Promise<AlertSettings> {
    const data: {
      notificationEmail?: string | null;
      emailAlertsEnabled?: boolean;
    } = {};
    if (input.notificationEmail !== undefined) {
      if (
        input.notificationEmail !== null &&
        typeof input.notificationEmail !== 'string'
      ) {
        throw new BadRequestException(
          'notificationEmail must be a string or null',
        );
      }
      const raw =
        input.notificationEmail === null ? '' : input.notificationEmail.trim();
      data.notificationEmail = raw === '' ? null : normalizeEmail(raw);
    }
    if (input.emailAlertsEnabled !== undefined) {
      if (typeof input.emailAlertsEnabled !== 'boolean') {
        throw new BadRequestException('emailAlertsEnabled must be a boolean');
      }
      data.emailAlertsEnabled = input.emailAlertsEnabled;
    }
    const user = await this.repository.updateAlertSettings(userId, data);
    return {
      notificationEmail: user.notificationEmail,
      emailAlertsEnabled: user.emailAlertsEnabled,
      effectiveEmail: user.notificationEmail ?? user.email,
    };
  }

  private jwtTtl(): string {
    return this.config.get<string>('JWT_TTL') ?? DEFAULT_JWT_TTL;
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

function jwtTtlSeconds(ttl: string): number {
  const trimmed = ttl.trim();
  const match = /^(\d+)([smhd])?$/.exec(trimmed);
  // 파싱 실패 시에도 쿠키와 JWT가 어긋나지 않도록 같은 기본값에서 재계산한다.
  // (하드코딩 12h로 떨어지면 JWT는 30일인데 쿠키만 12시간이 되어 TV가 죽는다.)
  if (!match) return jwtTtlSeconds(DEFAULT_JWT_TTL);
  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multiplier =
    unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return value * multiplier;
}
