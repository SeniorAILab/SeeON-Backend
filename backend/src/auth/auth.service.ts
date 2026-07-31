import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { assertValidPassword, requiredPassword } from './password-policy';
import { createRegisteredFacilityOwner } from './password-registration';
import { DEFAULT_JWT_TTL, hasRbacCapability } from './auth.constants';

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
    private readonly prisma: PrismaService,
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

    return this.createJwtSession(user);
  }

  async createFacilityForUser(
    userId: string,
    facilityName: string,
  ): Promise<AuthSession> {
    const name = facilityName.trim();
    if (!name) throw new BadRequestException('facilityName is required');

    const existing = await this.prisma.db.user.findUnique({
      where: { id: userId },
    });
    if (!existing) throw new UnauthorizedException('Unknown user');
    if (existing.facilityId) {
      return this.createJwtSession(existing);
    }

    const user = await this.prisma.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;

      const current = await tx.user.findUnique({
        where: { id: userId },
      });
      if (!current) throw new UnauthorizedException('Unknown user');
      if (current.facilityId) return current;

      const facility = await tx.facility.create({
        data: { name },
      });
      return tx.user.update({
        where: { id: userId },
        data: { facilityId: facility.id, role: 'ADMIN' },
      });
    });

    return this.createJwtSession(user);
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.db.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    });
  }

  async isSessionVersionCurrent(
    userId: string,
    expectedSessionVersion: number,
  ): Promise<boolean> {
    const user = await this.prisma.db.user.findUnique({
      where: { id: userId },
      select: { sessionVersion: true },
    });
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
    const user = await this.prisma.db.user.findUnique({
      where: { id: userId },
      select: {
        notificationEmail: true,
        emailAlertsEnabled: true,
        email: true,
      },
    });
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
    const user = await this.prisma.db.user.update({
      where: { id: userId },
      data,
      select: {
        notificationEmail: true,
        emailAlertsEnabled: true,
        email: true,
      },
    });
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
  if (!match) return 12 * 60 * 60;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2] ?? 's';
  const multiplier =
    unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return value * multiplier;
}
