import type { ExecutionContext } from '@nestjs/common';
import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EdgeIngestTokenGuard } from './edge-ingest-token.guard';
import type { EdgeCredentialAuthenticator } from '../edge-credentials/edge-credential-authenticator.js';
import { LegacyEdgeMetrics } from '../edge-credentials/legacy-edge-metrics.js';

function contextFor(headers: Record<string, string | undefined>) {
  const request = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('EdgeIngestTokenGuard', () => {
  it('injects facility, installation, generation, and active validation grant for v1', async () => {
    const principal = {
      tokenId: '7H2K9M4QXP3R',
      facilityId: 'facility-1',
      edgeInstallationId: 'c72bd9a7-3e04-47ba-a8cd-a56e54f98152',
      enrollmentGeneration: 1,
      validationRunId: '0197f671-3a31-7a6c-a6e4-83ed412de80f',
    };
    const authenticator = {
      authenticate: jest.fn().mockResolvedValue(principal),
      bindRequest: jest.fn().mockResolvedValue(principal),
    } as unknown as EdgeCredentialAuthenticator;
    const metrics = new LegacyEdgeMetrics();
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({ EDGE_FACILITY_TOKEN: 'legacy' }),
      authenticator,
      metrics,
    );
    const { context, request } = contextFor({
      authorization:
        'Bearer eft_v1.7H2K9M4QXP3R.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request).toHaveProperty('edgePrincipal', principal);
    expect(metrics.count('events.create')).toBe(0);
  });
  it('accepts the configured bearer token', () => {
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({
        EDGE_FACILITY_TOKEN: 'edge-token',
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
      }),
    );

    expect(
      guard.canActivate(
        contextFor({ authorization: 'Bearer edge-token' }).context,
      ),
    ).toBe(true);
  });

  it('accepts the edge relay header token', () => {
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({
        EDGE_FACILITY_TOKEN: 'edge-token',
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
      }),
    );

    expect(
      guard.canActivate(
        contextFor({ 'x-edge-relay-token': ' edge-token ' }).context,
      ),
    ).toBe(true);
  });

  it('no longer accepts API_EDGE_RELAY_TOKEN as a facility credential fallback', () => {
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({
        API_EDGE_RELAY_TOKEN: 'edge-token',
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
      }),
    );

    expect(() =>
      guard.canActivate(
        contextFor({ authorization: 'Bearer edge-token' }).context,
      ),
    ).toThrow(ServiceUnavailableException);
  });

  it('rejects missing and mismatched tokens without leaking token values', () => {
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({
        EDGE_FACILITY_TOKEN: 'edge-token',
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
      }),
    );

    expect(() => guard.canActivate(contextFor({}).context)).toThrow(
      UnauthorizedException,
    );
    expect(() =>
      guard.canActivate(
        contextFor({ 'x-edge-relay-token': 'wrong-token' }).context,
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(
        contextFor({ authorization: 'Bearer edge-tokeo' }).context,
      ),
    ).toThrow(ForbiddenException);
  });

  it('does not require a facility scope header', () => {
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({
        EDGE_FACILITY_TOKEN: 'edge-token',
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
      }),
    );

    expect(
      guard.canActivate(
        contextFor({ authorization: 'Bearer edge-token' }).context,
      ),
    ).toBe(true);
  });

  it('fails closed when the backend edge token is not configured', () => {
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({ EDGE_LEGACY_COMPAT_ENABLED: 'true' }),
    );

    expect(() =>
      guard.canActivate(
        contextFor({ 'x-edge-relay-token': 'edge-token' }).context,
      ),
    ).toThrow(ServiceUnavailableException);
  });

  describe('EDGE_LEGACY_COMPAT_ENABLED default', () => {
    it('defaults to disabled when unset, rejecting the shared legacy token', () => {
      const guard = new EdgeIngestTokenGuard(
        new ConfigService({ EDGE_FACILITY_TOKEN: 'edge-token' }),
      );

      expect(() =>
        guard.canActivate(
          contextFor({ authorization: 'Bearer edge-token' }).context,
        ),
      ).toThrow(ForbiddenException);
    });

    it('treats any non-"true" value as disabled, not just "false"', () => {
      for (const value of ['false', 'FALSE', 'True', '1', '', 'yes']) {
        const guard = new EdgeIngestTokenGuard(
          new ConfigService({
            EDGE_FACILITY_TOKEN: 'edge-token',
            EDGE_LEGACY_COMPAT_ENABLED: value,
          }),
        );

        expect(() =>
          guard.canActivate(
            contextFor({ authorization: 'Bearer edge-token' }).context,
          ),
        ).toThrow(ForbiddenException);
      }
    });

    it('enables the legacy shared-token path as before, only when explicitly "true"', () => {
      const guard = new EdgeIngestTokenGuard(
        new ConfigService({
          EDGE_FACILITY_TOKEN: 'edge-token',
          EDGE_LEGACY_COMPAT_ENABLED: 'true',
        }),
      );

      expect(
        guard.canActivate(
          contextFor({ authorization: 'Bearer edge-token' }).context,
        ),
      ).toBe(true);
    });

    it('rejects a request bearing only the shared static token when legacy is disabled', () => {
      const guard = new EdgeIngestTokenGuard(
        new ConfigService({ EDGE_FACILITY_TOKEN: 'edge-token' }),
      );

      expect(() =>
        guard.canActivate(
          contextFor({ authorization: 'Bearer edge-token' }).context,
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe('legacy usage logging', () => {
    it('logs a warning identifying the route, and never the token, when the legacy path is used', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        const guard = new EdgeIngestTokenGuard(
          new ConfigService({
            EDGE_FACILITY_TOKEN: 'super-secret-edge-token',
            EDGE_LEGACY_COMPAT_ENABLED: 'true',
          }),
        );

        expect(
          guard.canActivate(
            contextFor({ authorization: 'Bearer super-secret-edge-token' })
              .context,
          ),
        ).toBe(true);

        expect(warn).toHaveBeenCalledTimes(1);
        const [message] = warn.mock.calls[0] as [string];
        expect(message).toContain('events.create');
        expect(message).not.toContain('super-secret-edge-token');
      } finally {
        warn.mockRestore();
      }
    });
  });
});
