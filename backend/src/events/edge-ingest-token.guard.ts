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
  warnLegacyEdgeUsage,
} from '../edge-credentials/edge-legacy-compat.js';

export const EDGE_RELAY_TOKEN_HEADER = 'x-edge-relay-token';

export type EdgeIngestRequest = EdgeAuthenticatedRequest;

/**
 * Dedicated variant of cameras/edge-facility-token.guard.ts (issue #552) for the
 * Event API ingest routes (record, heartbeat, snapshot upload — #567). Checks the
 * same shared edge bearer
 * token, but does not require an x-facility-id header: record/heartbeat resolve
 * facility/tenancy server-side from camera_id ownership
 * (CamerasService.resolveForEventIngest), and snapshot upload resolves it from
 * eventId ownership (EventRecorderService.resolveForSnapshot) — never from a
 * client-declared header.
 */
@Injectable()
export class EdgeIngestTokenGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly authenticator?: EdgeCredentialAuthenticator,
    @Optional() private readonly metrics?: LegacyEdgeMetrics,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest<EdgeIngestRequest>();
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
    if (
      !isEdgeLegacyCompatEnabled(this.config) ||
      requestsValidationRun(request.body)
    ) {
      throw new ForbiddenException('edge facility token mismatch');
    }
    const expected = this.expectedToken();
    if (!tokensMatch(token, expected)) {
      throw new ForbiddenException('edge facility token mismatch');
    }

    const route = legacyRoute(request.originalUrl);
    this.metrics?.increment(route);
    // Facility scope is resolved downstream from camera/event ownership, not
    // at guard time, so there is nothing server-side-known to log yet here.
    warnLegacyEdgeUsage(route, null);
    return true;
  }

  private async activateV1(
    request: EdgeIngestRequest,
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

function legacyRoute(url: string | undefined): string {
  if (url?.includes('/heartbeat')) return 'events.heartbeat';
  if (url?.includes('/snapshot')) return 'events.snapshot';
  if (url?.includes('/ml-config/')) return 'ml-config.get';
  if (url?.includes('/clips/')) return 'events.clips';
  if (url?.includes('/capabilities')) return 'events.capabilities';
  return 'events.create';
}

function requestsValidationRun(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    ('validationRunId' in body || 'validation_run_id' in body)
  );
}
function tokensMatch(token: string, expected: string): boolean {
  const tokenHash = createHash('sha256').update(token).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(tokenHash, expectedHash);
}

function requestToken(request: EdgeIngestRequest): string | null {
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
