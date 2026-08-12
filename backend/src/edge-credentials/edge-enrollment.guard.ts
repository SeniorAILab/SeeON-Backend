import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  EdgeCredentialAuthenticator,
  type AuthenticatedEnrollment,
} from './edge-credential-authenticator.js';
import { EDGE_ERROR_CODES, edgeHttpError } from './edge-errors.js';
import { EnrollmentRateLimiter } from './enrollment-rate-limiter.js';

export type EdgeEnrollmentRequest = Request & {
  edgeEnrollment?: AuthenticatedEnrollment;
};

@Injectable()
export class EdgeEnrollmentGuard implements CanActivate {
  constructor(
    private readonly limiter: EnrollmentRateLimiter,
    private readonly authenticator: EdgeCredentialAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<EdgeEnrollmentRequest>();
    const facilityCode = readFacilityCode(request.body);
    if (!this.limiter.consume(sourceIp(request), facilityCode)) {
      throw edgeHttpError(429, EDGE_ERROR_CODES.RATE_LIMITED, true);
    }
    request.edgeEnrollment = await this.authenticator.authenticateForEnrollment(
      bearerToken(request.headers.authorization),
    );
    return true;
  }
}

function readFacilityCode(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return '';
  const value = (body as Record<string, unknown>).facilityCode;
  return typeof value === 'string' ? value : '';
}

function bearerToken(value: string | undefined): string {
  if (value === undefined) return '';
  const match = /^(\S+)\s+(\S+)$/.exec(value.trim());
  if (match === null) return '';
  return match[1].toLowerCase() === 'bearer' ? match[2] : '';
}

function sourceIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0];
  return (
    first?.trim() || request.ip || request.socket.remoteAddress || 'unknown'
  );
}
