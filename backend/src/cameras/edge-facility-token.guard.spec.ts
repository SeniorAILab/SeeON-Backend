import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EdgeFacilityTokenGuard } from './edge-facility-token.guard';

function contextFor(headers: Record<string, string | undefined>) {
  const request = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('EdgeFacilityTokenGuard', () => {
  it('accepts the configured bearer token and binds facility scope', () => {
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({ API_EDGE_RELAY_TOKEN: 'edge-token' }),
    );
    const { context, request } = contextFor({
      authorization: 'Bearer edge-token',
      'x-facility-id': 'facility-1',
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request).toHaveProperty('edgeFacilityId', 'facility-1');
  });

  it('accepts the edge relay header token and trims facility scope', () => {
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({ API_EDGE_RELAY_TOKEN: 'edge-token' }),
    );
    const { context, request } = contextFor({
      'x-edge-relay-token': ' edge-token ',
      'x-facility-id': ' facility-1 ',
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request).toHaveProperty('edgeFacilityId', 'facility-1');
  });

  it('rejects missing and mismatched tokens without leaking token values', () => {
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({ API_EDGE_RELAY_TOKEN: 'edge-token' }),
    );

    expect(() =>
      guard.canActivate(contextFor({ 'x-facility-id': 'facility-1' }).context),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(
        contextFor({
          'x-edge-relay-token': 'wrong-token',
          'x-facility-id': 'facility-1',
        }).context,
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects requests without a facility scope', () => {
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({ API_EDGE_RELAY_TOKEN: 'edge-token' }),
    );

    expect(() =>
      guard.canActivate(contextFor({ authorization: 'Bearer edge-token' }).context),
    ).toThrow(ForbiddenException);
  });

  it('fails closed when the backend edge token is not configured', () => {
    const guard = new EdgeFacilityTokenGuard(new ConfigService({}));

    expect(() =>
      guard.canActivate(
        contextFor({
          'x-edge-relay-token': 'edge-token',
          'x-facility-id': 'facility-1',
        }).context,
      ),
    ).toThrow(ServiceUnavailableException);
  });
});
