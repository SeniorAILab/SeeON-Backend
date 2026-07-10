import { IsString } from 'class-validator';

interface MlConfigCameraDto {
  id: string;
  spaceId: string;
  label: string;
  rtspUrl: string | null;
  online: boolean;
  spaceName: string | null;
  floorName: string | null;
  createdAt: string;
}

export interface MlConfigResponseDto {
  configVersion: number;
  nightWindow: {
    start: string;
    end: string;
    tz: string;
  };
  cameras: MlConfigCameraDto[];
}

// HH:MM format and blank-tz checks stay in MlConfigService as business-rule
// validation; these decorators only add crash-safety type checks so the
// service's regex/trim logic never runs against a non-string value.
export class UpdateNightWindowRequestDto {
  @IsString()
  start!: string;

  @IsString()
  end!: string;

  @IsString()
  tz!: string;
}
