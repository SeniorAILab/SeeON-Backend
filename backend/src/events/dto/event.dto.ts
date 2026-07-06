import { Transform } from 'class-transformer';
import {
  IsDate,
  IsNumber,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';

// Type/enum canonicalization (trim+lowercase) and enum-membership validation
// for `type`, plus the blank-after-trim check for `camera_id`, stay owned by
// EventRecorderService.record() (already independently re-validates both
// with matching BadRequestException messages). These decorators only add
// the type-safety net needed to prevent a 500 (TypeError) if a field arrives
// with the wrong JS type entirely.
export class RecordEventRequestDto {
  @IsString()
  camera_id!: string;

  @IsString()
  type!: string;

  // Only strings are coerced to Date; other JS types (number epoch millis,
  // boolean, etc.) pass through unchanged so @IsDate rejects them with 400,
  // matching the pre-migration requireString(...) + Date(...) + NaN reject.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? new Date(value) : value,
  )
  @IsDate()
  detected_at!: Date;

  @ValidateIf((o: RecordEventRequestDto) => o.confidence !== undefined)
  @IsNumber()
  confidence?: number;

  @ValidateIf((o: RecordEventRequestDto) => o.config_version !== undefined)
  @IsNumber()
  config_version?: number;

  @ValidateIf((o: RecordEventRequestDto) => o.model_version !== undefined)
  @IsString()
  model_version?: string;

  @ValidateIf((o: RecordEventRequestDto) => o.detector_version !== undefined)
  @IsString()
  detector_version?: string;

  @ValidateIf((o: RecordEventRequestDto) => o.operating_threshold !== undefined)
  @IsNumber()
  operating_threshold?: number;

  // Nullable (unlike the other optional string fields above): mirrors the
  // pre-migration optionalNullableString() check, which allowed null.
  @IsOptional()
  @IsString()
  snapshot_key?: string | null;

  @ValidateIf((o: RecordEventRequestDto) => o.clock_source !== undefined)
  @IsString()
  clock_source?: string;

  // Never read by the controller or service today (dead field on the wire
  // contract) — stays fully permissive per the "no manual check today" rule.
  facility_id?: string;
}
export class RecordHeartbeatRequestDto {
  @IsString()
  camera_id!: string;
}

export interface RecordHeartbeatResponseDto {
  ok: true;
}

export interface RecordEventResponseDto {
  id: string;
  status: 'created' | 'duplicate';
}

export interface EventResponseDto {
  id: string;
  facilityId: string;
  cameraId: string;
  spaceId: string;
  type: string;
  confidence: number | null;
  detectedAt: Date;
  createdAt: Date;
  modifiedAt: Date;
  configVersion: number | null;
  modelVersion: string | null;
  detectorVersion: string | null;
  operatingThreshold: number | null;
  snapshotKey: string | null;
  clockSource: string | null;
}
