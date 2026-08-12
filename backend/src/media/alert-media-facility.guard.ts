import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { buildAuthCookieOptions, readCookie } from '../auth/cookie.util.js';
import {
  readFacilityScopeHeader,
  type RequestWithAuth,
} from '../auth/jwt-auth.guard.js';

export const MEDIA_FACILITY_COOKIE_NAME = 'app_media_facility';
const MEDIA_FACILITY_COOKIE_MAX_AGE_MS = 5 * 60 * 1_000;
const FACILITY_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

@Injectable()
export class AlertMediaFacilityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithAuth>();
    const response = http.getResponse<Response>();
    const user = request.user;
    if (!user) throw new UnauthorizedException('Missing session');

    if (user.facilityId !== null) {
      request.effectiveFacilityId = user.facilityId;
      return true;
    }
    if (user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Facility onboarding required');
    }

    const selectedFromHeader = readFacilityScopeHeader(request);
    if (selectedFromHeader !== null) {
      requireSafeFacilityId(selectedFromHeader);
      request.effectiveFacilityId = selectedFromHeader;
      response.cookie(
        MEDIA_FACILITY_COOKIE_NAME,
        selectedFromHeader,
        buildAuthCookieOptions(request, MEDIA_FACILITY_COOKIE_MAX_AGE_MS),
      );
      return true;
    }

    const selectedFromCookie = readCookie(
      request.headers.cookie,
      MEDIA_FACILITY_COOKIE_NAME,
    );
    if (selectedFromCookie !== undefined) {
      requireSafeFacilityId(selectedFromCookie);
      request.effectiveFacilityId = selectedFromCookie;
      return true;
    }
    throw new ForbiddenException('Selected facility required');
  }
}

function requireSafeFacilityId(facilityId: string): void {
  if (!FACILITY_ID_PATTERN.test(facilityId)) {
    throw new ForbiddenException('Selected facility is invalid');
  }
}
