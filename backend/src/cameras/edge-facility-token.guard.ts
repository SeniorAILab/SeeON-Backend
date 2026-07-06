import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const EDGE_RELAY_TOKEN_HEADER = 'x-edge-relay-token';
export const EDGE_FACILITY_HEADER = 'x-facility-id';

export interface EdgeFacilityRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  edgeFacilityId?: string;
}

@Injectable()
export class EdgeFacilityTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<EdgeFacilityRequest>();
    const expected = this.expectedToken();
    const token = requestToken(request);

    if (token === null) {
      throw new UnauthorizedException('edge facility token required');
    }
    if (token !== expected) {
      throw new ForbiddenException('edge facility token mismatch');
    }

    const facilityId = headerValue(request.headers[EDGE_FACILITY_HEADER]);
    if (facilityId === null) {
      throw new ForbiddenException('facility scope required');
    }

    request.edgeFacilityId = facilityId;
    return true;
  }

  private expectedToken(): string {
    const token =
      configString(this.config, 'EDGE_FACILITY_TOKEN') ??
      configString(this.config, 'API_EDGE_RELAY_TOKEN');
    if (token === null) {
      throw new ServiceUnavailableException(
        'edge facility token is not configured',
      );
    }
    return token;
  }
}

function requestToken(request: EdgeFacilityRequest): string | null {
  const authorization =
    request.headers.authorization ?? request.headers.Authorization;
  return (
    bearerToken(headerValue(authorization)) ??
    headerValue(request.headers[EDGE_RELAY_TOKEN_HEADER])
  );
}

function bearerToken(value: string | null): string | null {
  if (value === null) return null;
  const [scheme, token] = value.trim().split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

function headerValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim();
}

function configString(config: ConfigService, key: string): string | null {
  const value = config.get<string>(key);
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim();
}
