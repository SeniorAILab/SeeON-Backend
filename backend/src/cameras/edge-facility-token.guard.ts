import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { EdgeCredentialAuthenticator } from '../edge-credentials/edge-credential-authenticator.js';
import type { EdgeAuthenticatedRequest } from '../edge-credentials/edge-credential.types.js';
import { LegacyEdgeMetrics } from '../edge-credentials/legacy-edge-metrics.js';

export const EDGE_RELAY_TOKEN_HEADER = 'x-edge-relay-token';
export const EDGE_FACILITY_HEADER = 'x-facility-id';

export type EdgeFacilityRequest = EdgeAuthenticatedRequest;

@Injectable()
export class EdgeFacilityTokenGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly authenticator?: EdgeCredentialAuthenticator,
    @Optional() private readonly metrics?: LegacyEdgeMetrics,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest<EdgeFacilityRequest>();
    const token = requestToken(request);

    if (token === null) {
      throw new UnauthorizedException('edge facility token required');
    }
    if (token.startsWith('eft_v1.')) return this.activateV1(request, token);
    if (configString(this.config, 'EDGE_LEGACY_COMPAT_ENABLED') === 'false') {
      throw new ForbiddenException('edge facility token mismatch');
    }
    const expected = this.expectedToken();
    if (!tokensMatch(token, expected)) {
      throw new ForbiddenException('edge facility token mismatch');
    }

    const facilityId = headerValue(request.headers[EDGE_FACILITY_HEADER]);
    if (facilityId === null) {
      throw new ForbiddenException('facility scope required');
    }

    request.edgeFacilityId = facilityId;
    this.metrics?.increment('edge.cameras');
    return true;
  }

  private async activateV1(
    request: EdgeFacilityRequest,
    token: string,
  ): Promise<boolean> {
    if (this.authenticator === undefined) {
      throw new ServiceUnavailableException(
        'edge authentication is unavailable',
      );
    }
    const principal = await this.authenticator.authenticate(token);
    request.edgePrincipal = await this.authenticator.bindRequest(
      request,
      principal,
    );
    request.edgeFacilityId = request.edgePrincipal.facilityId;
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
function tokensMatch(token: string, expected: string): boolean {
  const tokenHash = createHash('sha256').update(token).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(tokenHash, expectedHash);
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
  if (scheme.toLowerCase() !== 'bearer' || !token) return null;
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
