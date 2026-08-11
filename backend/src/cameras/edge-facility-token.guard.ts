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
import {
  configString,
  isEdgeLegacyCompatEnabled,
  resolveEdgeLegacyFacilityId,
  warnLegacyEdgeUsage,
} from '../edge-credentials/edge-legacy-compat.js';

export const EDGE_RELAY_TOKEN_HEADER = 'x-edge-relay-token';
// x-facility-id is intentionally not read anywhere in this guard: the legacy
// shared-token path must never trust a client-supplied facility scope. See
// edge-legacy-compat.ts for how the facility is resolved instead.

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
    // Fail-closed default: the legacy shared-token path only activates when
    // this is explicitly the string 'true'. Unset, empty, mixed case, or any
    // other value disables it — the transition-window opt-in must be
    // deliberate, never accidental. See edge-legacy-compat-characterization
    // spec for the pinned legacy behavior once explicitly enabled.
    if (!isEdgeLegacyCompatEnabled(this.config)) {
      throw new ForbiddenException('edge facility token mismatch');
    }
    const expected = this.expectedToken();
    if (!tokensMatch(token, expected)) {
      throw new ForbiddenException('edge facility token mismatch');
    }

    // The facility scope for the legacy path is never taken from a
    // client-supplied header: any holder of the one static shared token
    // could otherwise pick any facility it likes by changing x-facility-id.
    // Instead it is pinned server-side, for the duration of the migration
    // window only. If no pin is configured, the legacy path cannot
    // establish a facility scope and must fail closed rather than trust the
    // header.
    const facilityId = resolveEdgeLegacyFacilityId(this.config);
    if (facilityId === null) {
      throw new ServiceUnavailableException(
        'legacy edge facility scope is not configured',
      );
    }

    request.edgeFacilityId = facilityId;
    this.metrics?.increment('edge.cameras');
    warnLegacyEdgeUsage('edge.cameras', facilityId);
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
    // API_EDGE_RELAY_TOKEN is the Edge's internal ml-api<->ml-worker relay
    // token, not a Hub facility credential — it must never be accepted here.
    const token = configString(this.config, 'EDGE_FACILITY_TOKEN');
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
