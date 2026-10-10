export const ALERT_MEDIA_ACCESS_ACTIONS = [
  'PLAY_STARTED',
  'FULLSCREEN_ENTERED',
  'DOWNLOAD_STARTED',
] as const;

export type AlertMediaAccessAction =
  (typeof ALERT_MEDIA_ACCESS_ACTIONS)[number];
