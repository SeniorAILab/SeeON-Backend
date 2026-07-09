import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { SESSION_COOKIE_NAME } from './auth.constants';
import type { AuthenticatedUser } from './auth.types';
import { readCookie } from './cookie.util';

export interface JwtAuthPayload {
  sub: string;
  role: string;
  facilityId: string | null;
  sessionVersion: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([jwtCookieExtractor]),
      ignoreExpiration: false,
      secretOrKey: jwtSecret(config),
      passReqToCallback: false,
    });
  }

  async validate(payload: JwtAuthPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.db.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) throw new UnauthorizedException('Invalid session');
    if (user.sessionVersion !== payload.sessionVersion) {
      throw new UnauthorizedException('Stale session');
    }
    if (user.facilityId !== payload.facilityId || user.role !== payload.role) {
      throw new UnauthorizedException('Session claims mismatch');
    }
    return {
      id: user.id,
      facilityId: user.facilityId,
      role: user.role,
      email: user.email,
      nickname: user.nickname,
      sessionVersion: user.sessionVersion,
    };
  }
}

export function jwtCookieExtractor(
  request: Request | undefined,
): string | null {
  return readCookie(request?.headers.cookie, SESSION_COOKIE_NAME) ?? null;
}

export function jwtSecret(config: ConfigService): string {
  const secret =
    config.get<string>('SESSION_JWT_SECRET') ??
    config.get<string>('JWT_SECRET');
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_JWT_SECRET or JWT_SECRET must be at least 32 characters',
    );
  }
  return secret;
}
