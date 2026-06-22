import type { AlertEventType } from './alert-events.dto.js';
import type { AlertDeliveryMessage } from '../ports/channel.port.js';

/**
 * Structured, transport-agnostic payload for a caregiver-facing Kakao alert.
 * Built at the application/adapter seam from an AlertDeliveryMessage; the
 * adapter renders it into a Kakao "text" template. No debug/database IDs.
 */
export interface KakaoAlertMessageDto {
  readonly title: string;
  readonly residentName: string | null;
  readonly room: string | null;
  readonly detectedAtKST: string;
  readonly confidencePercent: number | null;
  readonly dashboardLink: string;
}

const MAX_TEXT_LENGTH = 180;
const FALLBACK_ROOM = '공간 미상';

const TITLE_BY_TYPE: Record<AlertEventType, string> = {
  fall: '🚨 낙상 감지',
  'bed-exit': '🚨 침대 이탈 감지',
  'detection-lost': '⚠️ 감지 신호 끊김',
};

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/** Format an ISO timestamp to KST `YYYY-MM-DD HH:mm KST`; passthrough if unparseable. */
export function formatDetectedAtKST(detectedAt: string): string {
  const date = new Date(detectedAt);
  if (Number.isNaN(date.getTime())) return detectedAt;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} KST`;
}

/** Map a backend delivery message to the Kakao alert DTO (applies fallbacks/clipping). */
export function toKakaoAlertMessageDto(
  message: AlertDeliveryMessage,
  dashboardLink: string,
): KakaoAlertMessageDto {
  const residentName = message.resident_name?.trim()
    ? clip(message.resident_name, 24)
    : null;
  const room = message.resident_room?.trim()
    ? clip(message.resident_room, 16)
    : null;
  const confidencePercent =
    message.confidence === undefined
      ? null
      : Math.round(message.confidence * 100);
  return {
    title: TITLE_BY_TYPE[message.type],
    residentName,
    room,
    detectedAtKST: formatDetectedAtKST(message.detected_at),
    confidencePercent,
    dashboardLink,
  };
}

/** Render the Korean rich-text body (emoji/newlines, <=180 chars, no debug IDs). */
export function buildKakaoAlertText(dto: KakaoAlertMessageDto): string {
  const who = dto.residentName
    ? `👤 ${dto.residentName}님`
    : `🏠 ${dto.room ?? FALLBACK_ROOM}`;
  const lines: string[] = [
    dto.title,
    dto.residentName && dto.room ? `${who} · 🏠 ${dto.room}` : who,
    `🕐 ${dto.detectedAtKST}`,
  ];
  if (dto.confidencePercent !== null) {
    lines.push(`📊 확신도 ${dto.confidencePercent}%`);
  }
  lines.push('👉 대시보드에서 상태 확인');
  const text = lines.join('\n');
  return text.length <= MAX_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

/** Build the Kakao `memo/default/send` text template_object from the DTO. */
export function buildKakaoTemplateObject(
  dto: KakaoAlertMessageDto,
): Record<string, unknown> {
  return {
    object_type: 'text',
    text: buildKakaoAlertText(dto),
    link: {
      web_url: dto.dashboardLink,
      mobile_web_url: dto.dashboardLink,
    },
  };
}
