import type { AlertEventType } from './alert-events.dto.js';
import type { AlertDeliveryMessage } from '../ports/channel.port.js';

/**
 * Structured, transport-agnostic payload for a staff-facing email alert.
 * Built at the application/adapter seam from an AlertDeliveryMessage; the
 * adapter renders it into an SMTP subject + text/html body. No debug/database IDs.
 */
export interface EmailAlertMessageDto {
  readonly subject: string;
  readonly title: string;
  readonly residentName: string | null;
  readonly room: string | null;
  readonly detectedAtKST: string;
  readonly confidencePercent: number | null;
  readonly dashboardLink: string;
}

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

/** Map a backend delivery message to the email alert DTO (applies fallbacks/clipping). */
export function toEmailAlertMessageDto(
  message: AlertDeliveryMessage,
  dashboardLink: string,
): EmailAlertMessageDto {
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
  const title = TITLE_BY_TYPE[message.type];
  const scope = residentName ?? room ?? FALLBACK_ROOM;
  return {
    subject: `[안전알림] ${title} · ${scope}`,
    title,
    residentName,
    room,
    detectedAtKST: formatDetectedAtKST(message.detected_at),
    confidencePercent,
    dashboardLink,
  };
}

/** Render the plain-text email body (no debug/database IDs). */
export function buildEmailAlertText(dto: EmailAlertMessageDto): string {
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
  lines.push('');
  lines.push(`👉 대시보드에서 상태 확인: ${dto.dashboardLink}`);
  return lines.join('\n');
}

/** Render a minimal HTML email body from the DTO. */
export function buildEmailAlertHtml(dto: EmailAlertMessageDto): string {
  const esc = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const who = dto.residentName
    ? `👤 ${esc(dto.residentName)}님`
    : `🏠 ${esc(dto.room ?? FALLBACK_ROOM)}`;
  const rows: string[] = [
    `<h2 style="margin:0 0 12px">${esc(dto.title)}</h2>`,
    `<p style="margin:4px 0">${
      dto.residentName && dto.room ? `${who} · 🏠 ${esc(dto.room)}` : who
    }</p>`,
    `<p style="margin:4px 0">🕐 ${esc(dto.detectedAtKST)}</p>`,
  ];
  if (dto.confidencePercent !== null) {
    rows.push(
      `<p style="margin:4px 0">📊 확신도 ${dto.confidencePercent}%</p>`,
    );
  }
  rows.push(
    `<p style="margin:16px 0 0"><a href="${esc(dto.dashboardLink)}">대시보드에서 상태 확인</a></p>`,
  );
  return `<div style="font-family:sans-serif;font-size:14px;line-height:1.5">${rows.join('')}</div>`;
}
