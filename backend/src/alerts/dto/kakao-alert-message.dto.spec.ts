import type { AlertDeliveryMessage } from '../ports/channel.port.js';
import {
  buildKakaoAlertText,
  buildKakaoTemplateObject,
  formatDetectedAtKST,
  toKakaoAlertMessageDto,
} from './kakao-alert-message.dto.js';

function message(
  overrides: Partial<AlertDeliveryMessage> = {},
): AlertDeliveryMessage {
  return {
    type: 'fall',
    source_id: 'demo-cam-01',
    external_event_id: 'evt-abc-123',
    detected_at: '2026-06-18T06:04:00Z',
    confidence: 0.923,
    event_id: 'event-uuid',
    delivery_attempt_id: 'attempt-uuid',
    created_at: new Date('2026-06-18T06:04:01Z'),
    recipient_access_token: 'token',
    resident_name: '홍길동',
    resident_room: '302호',
    ...overrides,
  };
}

const DASHBOARD = 'https://dash.example.com';

describe('formatDetectedAtKST', () => {
  it('formats a UTC instant to KST YYYY-MM-DD HH:mm KST', () => {
    expect(formatDetectedAtKST('2026-06-18T06:04:00Z')).toBe(
      '2026-06-18 15:04 KST',
    );
  });

  it('passes through an unparseable timestamp', () => {
    expect(formatDetectedAtKST('not-a-date')).toBe('not-a-date');
  });
});

describe('toKakaoAlertMessageDto', () => {
  it('maps resident/room/confidence and the provided dashboard link', () => {
    const dto = toKakaoAlertMessageDto(message(), DASHBOARD);
    expect(dto).toMatchObject({
      title: '🚨 낙상 감지',
      residentName: '홍길동',
      room: '302호',
      detectedAtKST: '2026-06-18 15:04 KST',
      confidencePercent: 92,
      dashboardLink: DASHBOARD,
    });
  });

  it('rounds confidence (0-1) to a whole percent', () => {
    expect(toKakaoAlertMessageDto(message({ confidence: 0.5 }), DASHBOARD).confidencePercent).toBe(50);
    expect(toKakaoAlertMessageDto(message({ confidence: 0.876 }), DASHBOARD).confidencePercent).toBe(88);
  });

  it('uses a fallback resident name and null room when absent', () => {
    const dto = toKakaoAlertMessageDto(
      message({ resident_name: undefined, resident_room: null }),
      DASHBOARD,
    );
    expect(dto.residentName).toBe('거주자 미상');
    expect(dto.room).toBeNull();
  });

  it('uses null confidencePercent when confidence is absent', () => {
    expect(
      toKakaoAlertMessageDto(message({ confidence: undefined }), DASHBOARD)
        .confidencePercent,
    ).toBeNull();
  });

  it('titles by alert type', () => {
    expect(toKakaoAlertMessageDto(message({ type: 'bed-exit' }), DASHBOARD).title).toBe('🚨 침대 이탈 감지');
    expect(toKakaoAlertMessageDto(message({ type: 'detection-lost' }), DASHBOARD).title).toBe('⚠️ 감지 신호 끊김');
  });
});

describe('buildKakaoAlertText', () => {
  it('renders Korean rich text with resident, room, KST time, confidence, and a dashboard prompt', () => {
    const text = buildKakaoAlertText(toKakaoAlertMessageDto(message(), DASHBOARD));
    expect(text).toContain('🚨 낙상 감지');
    expect(text).toContain('홍길동님');
    expect(text).toContain('302호');
    expect(text).toContain('2026-06-18 15:04 KST');
    expect(text).toContain('확신도 92%');
    expect(text).toContain('대시보드에서 상태 확인');
    expect(text).toContain('\n');
  });

  it('never leaks debug/database identifiers', () => {
    const text = buildKakaoAlertText(toKakaoAlertMessageDto(message(), DASHBOARD));
    for (const leak of [
      'demo-cam-01',
      'evt-abc-123',
      'event-uuid',
      'attempt-uuid',
      'source_id',
      'external_event_id',
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it('omits the confidence line when confidence is absent', () => {
    const text = buildKakaoAlertText(
      toKakaoAlertMessageDto(message({ confidence: undefined }), DASHBOARD),
    );
    expect(text).not.toContain('확신도');
  });

  it('stays within 180 characters even for long resident/room values', () => {
    const text = buildKakaoAlertText(
      toKakaoAlertMessageDto(
        message({
          resident_name: '가'.repeat(120),
          resident_room: '나'.repeat(120),
        }),
        DASHBOARD,
      ),
    );
    expect(text.length).toBeLessThanOrEqual(180);
  });
});

describe('buildKakaoTemplateObject', () => {
  it('produces a Kakao text template with the dashboard link on both url fields', () => {
    const template = buildKakaoTemplateObject(
      toKakaoAlertMessageDto(message(), DASHBOARD),
    );
    expect(template.object_type).toBe('text');
    expect(template.link).toEqual({
      web_url: DASHBOARD,
      mobile_web_url: DASHBOARD,
    });
    expect(typeof template.text).toBe('string');
  });
});
