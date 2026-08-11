import type { ExecutionContext } from '@nestjs/common';
import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EdgeFacilityTokenGuard } from './edge-facility-token.guard';
import type { EdgeCredentialAuthenticator } from '../edge-credentials/edge-credential-authenticator.js';
import { LegacyEdgeMetrics } from '../edge-credentials/legacy-edge-metrics.js';

function contextFor(headers: Record<string, string | undefined>) {
  const request = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('EdgeFacilityTokenGuard', () => {
  it('injects a token-derived principal and never falls through v1 to legacy', async () => {
    const principal = {
      tokenId: '7H2K9M4QXP3R',
      facilityId: 'facility-1',
      edgeInstallationId: 'c72bd9a7-3e04-47ba-a8cd-a56e54f98152',
      enrollmentGeneration: 1,
    };
    const authenticator = {
      authenticate: jest.fn().mockResolvedValue(principal),
      bindRequest: jest.fn().mockResolvedValue(principal),
    } as unknown as EdgeCredentialAuthenticator;
    const metrics = new LegacyEdgeMetrics();
    const guard = new EdgeFacilityTokenGuard(
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
    expect(request).toHaveProperty('edgeFacilityId', 'facility-1');
    expect(metrics.count('edge.cameras')).toBe(0);
  });

  it('never accepts malformed eft_v1 through the legacy shared-token path', async () => {
    const authenticate = jest
      .fn()
      .mockRejectedValue(new UnauthorizedException());
    const authenticator = {
      authenticate,
    } as unknown as EdgeCredentialAuthenticator;
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({ EDGE_FACILITY_TOKEN: 'eft_v1.invalid' }),
      authenticator,
    );
    await expect(
      guard.canActivate(
        contextFor({
          authorization: 'Bearer eft_v1.invalid',
          'x-facility-id': 'facility-1',
        }).context,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('counts only successful enumerated legacy camera acceptance', () => {
    const metrics = new LegacyEdgeMetrics();
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({
        EDGE_FACILITY_TOKEN: 'legacy',
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
        EDGE_LEGACY_FACILITY_ID: 'facility-1',
      }),
      undefined,
      metrics,
    );
    expect(
      guard.canActivate(
        contextFor({
          authorization: 'Bearer legacy',
          'x-facility-id': 'some-other-facility',
        }).context,
      ),
    ).toBe(true);
    expect(metrics.count('edge.cameras')).toBe(1);
  });
  it('accepts the configured bearer token and binds the server-pinned facility scope', () => {
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({
        EDGE_FACILITY_TOKEN: 'edge-token',
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
        EDGE_LEGACY_FACILITY_ID: 'facility-1',
      }),
    );
    const { context, request } = contextFor({
      authorization: 'Bearer edge-token',
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request).toHaveProperty('edgeFacilityId', 'facility-1');
  });

  it('accepts the edge relay header token and binds the server-pinned facility scope', () => {
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({
        EDGE_FACILITY_TOKEN: 'edge-token',
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
        EDGE_LEGACY_FACILITY_ID: ' facility-1 ',
      }),
    );
    const { context, request } = contextFor({
      'x-edge-relay-token': ' edge-token ',
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request).toHaveProperty('edgeFacilityId', 'facility-1');
  });

  it('rejects missing and mismatched tokens without leaking token values', () => {
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({
        EDGE_FACILITY_TOKEN: 'edge-token',
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
        EDGE_LEGACY_FACILITY_ID: 'facility-1',
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

  it('fails closed when legacy compat is enabled but no server-side facility scope is configured', () => {
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({
        EDGE_FACILITY_TOKEN: 'edge-token',
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
      }),
    );
    const { context, request } = contextFor({
      authorization: 'Bearer edge-token',
      'x-facility-id': 'any-facility-the-caller-wants',
    });

    expect(() => guard.canActivate(context)).toThrow(
      ServiceUnavailableException,
    );
    expect(request).not.toHaveProperty('edgeFacilityId');
  });

  it('fails closed when the backend edge token is not configured', () => {
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({
        EDGE_LEGACY_COMPAT_ENABLED: 'true',
        EDGE_LEGACY_FACILITY_ID: 'facility-1',
      }),
    );

    expect(() =>
      guard.canActivate(
        contextFor({ 'x-edge-relay-token': 'edge-token' }).context,
      ),
    ).toThrow(ServiceUnavailableException);
  });

  describe('EDGE_LEGACY_COMPAT_ENABLED default', () => {
    it('defaults to disabled when unset, rejecting the shared legacy token', () => {
      const guard = new EdgeFacilityTokenGuard(
        new ConfigService({
          EDGE_FACILITY_TOKEN: 'edge-token',
          EDGE_LEGACY_FACILITY_ID: 'facility-1',
        }),
      );

      expect(() =>
        guard.canActivate(
          contextFor({ authorization: 'Bearer edge-token' }).context,
        ),
      ).toThrow(ForbiddenException);
    });

    it('treats any non-"true" value as disabled, not just "false"', () => {
      for (const value of ['false', 'FALSE', 'True', '1', '', 'yes']) {
        const guard = new EdgeFacilityTokenGuard(
          new ConfigService({
            EDGE_FACILITY_TOKEN: 'edge-token',
            EDGE_LEGACY_COMPAT_ENABLED: value,
            EDGE_LEGACY_FACILITY_ID: 'facility-1',
          }),
        );

        expect(() =>
          guard.canActivate(
            contextFor({ authorization: 'Bearer edge-token' }).context,
          ),
        ).toThrow(ForbiddenException);
      }
    });

    it('enables the legacy shared-token path, binding the server-pinned facility scope, only when explicitly "true"', () => {
      const guard = new EdgeFacilityTokenGuard(
        new ConfigService({
          EDGE_FACILITY_TOKEN: 'edge-token',
          EDGE_LEGACY_COMPAT_ENABLED: 'true',
          EDGE_LEGACY_FACILITY_ID: 'facility-1',
        }),
      );
      const { context, request } = contextFor({
        authorization: 'Bearer edge-token',
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(request).toHaveProperty('edgeFacilityId', 'facility-1');
    });

    it('rejects a request bearing only the shared static token when legacy is disabled, never reaching facility resolution', () => {
      const guard = new EdgeFacilityTokenGuard(
        new ConfigService({
          EDGE_FACILITY_TOKEN: 'edge-token',
          EDGE_LEGACY_FACILITY_ID: 'facility-1',
        }),
      );
      const { context, request } = contextFor({
        authorization: 'Bearer edge-token',
        'x-facility-id': 'any-facility-the-caller-wants',
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(request).not.toHaveProperty('edgeFacilityId');
    });

    it('no longer accepts API_EDGE_RELAY_TOKEN as a facility credential fallback', () => {
      const guard = new EdgeFacilityTokenGuard(
        new ConfigService({
          API_EDGE_RELAY_TOKEN: 'edge-token',
          EDGE_LEGACY_COMPAT_ENABLED: 'true',
          EDGE_LEGACY_FACILITY_ID: 'facility-1',
        }),
      );

      expect(() =>
        guard.canActivate(
          contextFor({ authorization: 'Bearer edge-token' }).context,
        ),
      ).toThrow(ServiceUnavailableException);
    });
  });

  describe('legacy facility scope', () => {
    it('never trusts a client-supplied x-facility-id header, even when it names a different facility', () => {
      const guard = new EdgeFacilityTokenGuard(
        new ConfigService({
          EDGE_FACILITY_TOKEN: 'edge-token',
          EDGE_LEGACY_COMPAT_ENABLED: 'true',
          EDGE_LEGACY_FACILITY_ID: 'facility-1',
        }),
      );
      const { context, request } = contextFor({
        'x-edge-relay-token': 'edge-token',
        // An edge holding the one static shared token cannot pick its own
        // facility scope by changing this header — the server-side pin
        // always wins.
        'x-facility-id': 'some-other-facility',
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(
        (request as unknown as { edgeFacilityId?: string }).edgeFacilityId,
      ).toBe('facility-1');
    });
  });

  describe('legacy usage logging', () => {
    it('logs a warning identifying the route and facility, and never the token, when the legacy path is used', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        const guard = new EdgeFacilityTokenGuard(
          new ConfigService({
            EDGE_FACILITY_TOKEN: 'super-secret-edge-token',
            EDGE_LEGACY_COMPAT_ENABLED: 'true',
            EDGE_LEGACY_FACILITY_ID: 'facility-1',
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
        expect(message).toContain('edge.cameras');
        expect(message).toContain('facility-1');
        expect(message).not.toContain('super-secret-edge-token');
      } finally {
        warn.mockRestore();
      }
    });
  });
});
