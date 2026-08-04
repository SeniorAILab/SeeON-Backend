import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as authConstants from './auth.constants';
import { DEFAULT_JWT_TTL, SESSION_COOKIE_NAME } from './auth.constants';

/**
 * A1: 세션 수명 30일.
 *
 * 요양보호사가 TV에 화면을 상시 띄워두고 낙상 알림을 받는다. refresh 경로가
 * 없으므로 TTL 만료 = TV 사망이다. 12h였을 때 아침에 켠 TV가 저녁에 죽었고,
 * 그 시간대가 낙상이 제일 많은 야간이었다.
 */
describe('auth session TTL', () => {
  const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

  it('기본 JWT TTL이 30일이다', () => {
    expect(DEFAULT_JWT_TTL).toBe('30d');
  });

  it('30일은 정확히 2592000초다', () => {
    expect(THIRTY_DAYS_SECONDS).toBe(2_592_000);
  });

  it('쿠키 이름은 그대로 유지되어 기존 세션 소비측이 깨지지 않는다', () => {
    expect(SESSION_COOKIE_NAME).toBe('app_session');
  });

  it('TTL 문자열이 d 단위 파서와 호환된다', () => {
    // auth.service.jwtTtlSeconds()가 쓰는 것과 같은 패턴.
    const match = /^(\d+)([smhd])?$/.exec(DEFAULT_JWT_TTL);
    if (match === null) {
      throw new Error(`DEFAULT_JWT_TTL is not parseable: ${DEFAULT_JWT_TTL}`);
    }
    const value = Number.parseInt(match[1], 10);
    const unit = match[2];
    const multiplier =
      unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    expect(value * multiplier).toBe(THIRTY_DAYS_SECONDS);
  });

  it('refresh 토큰 상수를 도입하지 않았다', () => {
    const refreshKeys = Object.keys(authConstants).filter((key) =>
      key.toUpperCase().includes('REFRESH'),
    );
    expect(refreshKeys).toEqual([]);
  });

  it('TTL이 길어져도 즉시 무효화 수단이 남아 있다', () => {
    // backend/src/auth/AGENTS.md: "Enforce sessionVersion ... on every tenant
    // operation; logout invalidates existing sessions."
    // 30일 TTL은 그 자체로 위험하지 않다 — sessionVersion이 매 요청 검증되고
    // 로그아웃이 증가시키기 때문이다. 그 연결이 끊기면 30일짜리 토큰을
    // 회수할 방법이 사라진다.
    const strategy = readFileSync(join(__dirname, 'jwt.strategy.ts'), 'utf8');
    expect(strategy).toContain(
      'user.sessionVersion !== payload.sessionVersion',
    );

    const service = readFileSync(join(__dirname, 'auth.service.ts'), 'utf8');
    expect(service).toContain('sessionVersion: { increment: 1 }');
  });
});
