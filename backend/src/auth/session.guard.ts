import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SESSION_COOKIE_NAME } from './auth.constants';
import { readCookie } from './cookie.util';
import { SessionService } from './session.service';
import type { AuthenticatedUser } from './auth.types';

// Express Request already provides headers: IncomingHttpHeaders which is wider
// than AuthenticatedRequest.headers — extending both causes an incompatible
// intersection. We include the auth-specific fields directly instead.
export interface RequestWithAuth extends Request {
  user?: AuthenticatedUser;
  sessionId?: string;
  rotatedSessionToken?: string | null;
  rotatedSessionMaxAgeSeconds?: number;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    const valid = await this.sessions.validateToken(token);
    request.user = valid.user;
    request.sessionId = valid.session.id;
    request.rotatedSessionToken = valid.rotatedToken;
    request.rotatedSessionMaxAgeSeconds = valid.maxAgeSeconds;
    return true;
  }
}

@Injectable()
export class RequireOrgGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    if (!request.user) throw new UnauthorizedException('Missing session');
    if (!request.user.orgId)
      throw new ForbiddenException('Organization onboarding required');
    return true;
  }
}
