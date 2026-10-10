import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import {
  ALERT_MEDIA_ACCESS_ACTIONS,
  type AlertMediaAccessAction,
} from '../alert-media.types.js';

export class AlertMediaAccessRequestDto {
  @IsIn(ALERT_MEDIA_ACCESS_ACTIONS)
  readonly action!: AlertMediaAccessAction;

  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  readonly interactionId!: string;
}
