import type { ExecutionContext } from '@nestjs/common';
import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EdgeIngestTokenGuard } from './edge-ingest-token.guard';

function contextFor(headers: Record<string, string | undefined>) {
  const request = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('EdgeIngestTokenGuard', () => {
  it('accepts the configured bearer token', () => {
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({ EDGE_FACILITY_TOKEN: 'edge-token' }),
    );

    expect(
      guard.canActivate(
        contextFor({ authorization: 'Bearer edge-token' }).context,
      ),
    ).toBe(true);
  });

  it('accepts the edge relay header token', () => {
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({ EDGE_FACILITY_TOKEN: 'edge-token' }),
    );

    expect(
      guard.canActivate(
        contextFor({ 'x-edge-relay-token': ' edge-token ' }).context,
      ),
    ).toBe(true);
  });

  it('falls back to API_EDGE_RELAY_TOKEN when EDGE_FACILITY_TOKEN is unset', () => {
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({ API_EDGE_RELAY_TOKEN: 'edge-token' }),
    );

    expect(
      guard.canActivate(
        contextFor({ authorization: 'Bearer edge-token' }).context,
      ),
    ).toBe(true);
  });

  it('rejects missing and mismatched tokens without leaking token values', () => {
    const guard = new EdgeIngestTokenGuard(
      new ConfigService({ EDGE_FACILITY_TOKEN: 'edge-token' }),
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
      new ConfigService({ EDGE_FACILITY_TOKEN: 'edge-token' }),
    );

    expect(
      guard.canActivate(
        contextFor({ authorization: 'Bearer edge-token' }).context,
      ),
    ).toBe(true);
  });

  it('fails closed when the backend edge token is not configured', () => {
    const guard = new EdgeIngestTokenGuard(new ConfigService({}));

    expect(() =>
      guard.canActivate(
        contextFor({ 'x-edge-relay-token': 'edge-token' }).context,
      ),
    ).toThrow(ServiceUnavailableException);
  });
});
