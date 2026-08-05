import type { ExecutionContext } from '@nestjs/common';
import {
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
    expect(() =>
      guard.canActivate(
        contextFor({
          authorization: 'Bearer edge-tokeo',
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
      guard.canActivate(
        contextFor({ authorization: 'Bearer edge-token' }).context,
      ),
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

  /**
   * 알려진 한계 — 2번째 시설 온보딩 전 필수 해결.
   *
   * 이 가드는 공유 엣지 토큰만 검증하고 `x-facility-id`는 **검증 없이**
   * 그대로 `edgeFacilityId`로 실어준다. 즉 토큰을 가진 엣지가 헤더만 바꾸면
   * 다른 시설 범위로 요청할 수 있다.
   *
   * 단일 시설 파일럿에서는 노출되지 않지만(토큰 보유자 = 그 시설 엣지),
   * 시설이 둘 이상이 되는 순간 실제 위험이 된다.
   *
   * 아래 테스트는 그 동작을 **고정**하는 것이 아니라 **가시화**한다.
   * 해결 시 이 테스트가 깨지고, 그때 제대로 된 검증 테스트로 교체하면 된다.
   * (참고: EdgeIngestTokenGuard는 x-facility-id를 보지 않고 서버에서 소유권을
   * 해석하므로 이벤트 주입 경로는 이 한계에 해당하지 않는다.)
   */
  it('KNOWN LIMITATION: x-facility-id를 검증 없이 신뢰한다', () => {
    const guard = new EdgeFacilityTokenGuard(
      new ConfigService({ API_EDGE_RELAY_TOKEN: 'edge-token' }),
    );
    const { context, request } = contextFor({
      'x-edge-relay-token': 'edge-token',
      // 이 엣지가 실제로 어느 시설 소속인지 서버는 확인하지 않는다.
      'x-facility-id': 'some-other-facility',
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(
      (request as unknown as { edgeFacilityId?: string }).edgeFacilityId,
    ).toBe('some-other-facility');
  });
});
