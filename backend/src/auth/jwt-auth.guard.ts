import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import type { AuthenticatedUser } from './auth.types';

export interface RequestWithAuth extends Request {
  user?: AuthenticatedUser;
  effectiveFacilityId?: string;
}

const FACILITY_SCOPE_HEADER = 'x-facility-id';
const FACILITY_SCOPE_QUERY = 'facilityId';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

@Injectable()
export class RequireFacilityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    if (!request.user) throw new UnauthorizedException('Missing session');
    if (request.user.facilityId) {
      request.effectiveFacilityId = request.user.facilityId;
      return true;
    }
    const requestedFacilityId = readFacilityScope(request);
    if (request.user.role === 'SUPER_ADMIN' && requestedFacilityId) {
      request.effectiveFacilityId = requestedFacilityId;
      return true;
    }
    throw new ForbiddenException('Facility onboarding required');
  }
}

export function readFacilityScope(request: RequestWithAuth): string | null {
  return (
    readFacilityScopeValue(request.headers[FACILITY_SCOPE_HEADER]) ??
    readFacilityScopeValue(request.query[FACILITY_SCOPE_QUERY])
  );
}

export function readFacilityScopeHeader(
  request: RequestWithAuth,
): string | null {
  return readFacilityScopeValue(request.headers[FACILITY_SCOPE_HEADER]);
}

function readFacilityScopeValue(value: unknown): string | null {
  const raw = Array.isArray(value)
    ? value.find((item: unknown): item is string => typeof item === 'string')
    : value;
  if (typeof raw !== 'string') return null;
  const facilityId = raw.trim();
  return facilityId.length > 0 ? facilityId : null;
}
