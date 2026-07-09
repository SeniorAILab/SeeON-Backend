import type { AlertDeliveryMessage } from '../ports/channel.port.js';
import {
  buildEmailAlertHtml,
  buildEmailAlertText,
  formatDetectedAtKST,
  toEmailAlertMessageDto,
} from './email-alert-message.dto.js';

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
    recipient_email: 'admin@example.test',
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

describe('toEmailAlertMessageDto', () => {
  it('maps resident/room/confidence and the provided dashboard link', () => {
    const dto = toEmailAlertMessageDto(message(), DASHBOARD);
    expect(dto).toMatchObject({
      title: '🚨 낙상 감지',
      residentName: '홍길동',
      room: '302호',
      detectedAtKST: '2026-06-18 15:04 KST',
      confidencePercent: 92,
      dashboardLink: DASHBOARD,
    });
    expect(dto.subject).toContain('낙상 감지');
  });

  it('rounds confidence (0-1) to a whole percent', () => {
    expect(
      toEmailAlertMessageDto(message({ confidence: 0.5 }), DASHBOARD)
        .confidencePercent,
    ).toBe(50);
    expect(
      toEmailAlertMessageDto(message({ confidence: 0.876 }), DASHBOARD)
        .confidencePercent,
    ).toBe(88);
  });

  it('uses null resident name and room label when resident is absent', () => {
    const dto = toEmailAlertMessageDto(
      message({ resident_name: undefined, resident_room: 'Room 101' }),
      DASHBOARD,
    );
    expect(dto.residentName).toBeNull();
    expect(dto.room).toBe('Room 101');
  });

  it('uses null confidencePercent when confidence is absent', () => {
    expect(
      toEmailAlertMessageDto(message({ confidence: undefined }), DASHBOARD)
        .confidencePercent,
    ).toBeNull();
  });

  it('titles by alert type', () => {
    expect(
      toEmailAlertMessageDto(message({ type: 'bed-exit' }), DASHBOARD).title,
    ).toBe('🚨 침대 이탈 감지');
    expect(
      toEmailAlertMessageDto(message({ type: 'detection-lost' }), DASHBOARD)
        .title,
    ).toBe('⚠️ 감지 신호 끊김');
  });
});

describe('buildEmailAlertText', () => {
  it('renders Korean rich text with resident, room, KST time, confidence, and a dashboard prompt', () => {
    const text = buildEmailAlertText(
      toEmailAlertMessageDto(message(), DASHBOARD),
    );
    expect(text).toContain('🚨 낙상 감지');
    expect(text).toContain('홍길동님');
    expect(text).toContain('302호');
    expect(text).toContain('2026-06-18 15:04 KST');
    expect(text).toContain('확신도 92%');
    expect(text).toContain('대시보드에서 상태 확인');
    expect(text).toContain(DASHBOARD);
    expect(text).toContain('\n');
  });

  it('renders room label instead of fake resident text when resident is absent', () => {
    const text = buildEmailAlertText(
      toEmailAlertMessageDto(
        message({ resident_name: undefined, resident_room: 'Room 101' }),
        DASHBOARD,
      ),
    );
    expect(text).toContain('🏠 Room 101');
    expect(text).not.toContain('거주자 미상');
    expect(text).not.toContain('님');
  });

  it('never leaks debug/database identifiers', () => {
    const text = buildEmailAlertText(
      toEmailAlertMessageDto(message(), DASHBOARD),
    );
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
    const text = buildEmailAlertText(
      toEmailAlertMessageDto(message({ confidence: undefined }), DASHBOARD),
    );
    expect(text).not.toContain('확신도');
  });
});

describe('buildEmailAlertHtml', () => {
  it('renders an HTML body with the dashboard link and title', () => {
    const html = buildEmailAlertHtml(
      toEmailAlertMessageDto(message(), DASHBOARD),
    );
    expect(html).toContain('<h2');
    expect(html).toContain('낙상 감지');
    expect(html).toContain(`href="${DASHBOARD}"`);
    expect(html).toContain('확신도 92%');
  });

  it('HTML-escapes resident/room values to prevent markup injection', () => {
    const html = buildEmailAlertHtml(
      toEmailAlertMessageDto(
        message({
          resident_name: '<script>alert("xss")</script>',
          resident_room: '3<0>2"호',
        }),
        DASHBOARD,
      ),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;xss&quot;');
    expect(html).toContain('3&lt;0&gt;2&quot;호');
  });

  it('omits the confidence line when confidence is absent', () => {
    const html = buildEmailAlertHtml(
      toEmailAlertMessageDto(message({ confidence: undefined }), DASHBOARD),
    );
    expect(html).not.toContain('확신도');
  });
});
