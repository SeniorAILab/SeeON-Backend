import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_FEATURE_DISABLED_CODE } from './alert-media.service';

/**
 * 근거 영상 기능이 꺼져 있을 때(`EVENT_CLIPS_ENABLED !== 'true'`)와
 * "이 알림에 클립이 없을 때"는 다른 사실이다.
 *
 * 둘 다 밋밋한 404로 응답하면 화면이 "이 알림에 연결된 근거 영상이 없습니다"
 * 라고 말하는데, 실제로는 녹화 자체가 켜져 있지 않다. 원장이 그 알림만
 * 녹화에 실패한 것으로 오해한다 — 지어낸 상태다.
 */
describe('alert media feature flag', () => {
  const source = readFileSync(
    join(__dirname, 'alert-media.service.ts'),
    'utf8',
  );

  it('기능 비활성 코드가 정의되어 있다', () => {
    expect(MEDIA_FEATURE_DISABLED_CODE).toBe('MEDIA_FEATURE_DISABLED');
  });

  it('requireEnabled가 구분 가능한 코드를 실어 던진다', () => {
    const guardIndex = source.indexOf('private requireEnabled()');
    expect(guardIndex).toBeGreaterThan(-1);
    const guardBody = source.slice(guardIndex, guardIndex + 700);
    expect(guardBody).toContain("EVENT_CLIPS_ENABLED !== 'true'");
    expect(guardBody).toContain('MEDIA_FEATURE_DISABLED_CODE');
  });

  it('기본값은 비활성이다 — 명시적으로 켜야 한다', () => {
    // 'true'가 아닌 모든 값(미설정 포함)에서 꺼진다.
    expect(source).toContain("process.env.EVENT_CLIPS_ENABLED !== 'true'");
  });

  it('일반 404 경로는 그대로 남아 두 사실이 섞이지 않는다', () => {
    // notFound()는 "클립 없음/찾을 수 없음"에 계속 쓰인다.
    expect(source).toContain('function notFound()');
    expect(source).toContain('FacilityScopedNotFoundException');
  });
});
