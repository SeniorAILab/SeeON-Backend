import { IsIn, IsString, Matches, MaxLength } from 'class-validator';

export const ALERT_MEDIA_ACCESS_ACTIONS = [
  'PLAY_STARTED',
  'FULLSCREEN_ENTERED',
] as const;

export type AlertMediaAccessAction =
  (typeof ALERT_MEDIA_ACCESS_ACTIONS)[number];

export class AlertMediaAccessRequestDto {
  @IsIn(ALERT_MEDIA_ACCESS_ACTIONS)
  readonly action!: AlertMediaAccessAction;

  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  readonly interactionId!: string;
}
