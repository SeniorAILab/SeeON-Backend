import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Min,
} from 'class-validator';

const EDGE_UNAVAILABLE_REASONS = [
  'CAPTURE_FAILED',
  'QUEUE_FULL',
  'CORRUPT',
  'UPLOAD_TIMEOUT',
] as const;

export class EdgeMediaCapabilityQueryDto {
  @IsString()
  camera_id!: string;
}

export class ReportUnavailableClipRequestDto {
  @IsString()
  camera_id!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  event_refs!: string[];

  @IsInt()
  @Min(1)
  state_version!: number;

  @IsIn(EDGE_UNAVAILABLE_REASONS)
  reason!: (typeof EDGE_UNAVAILABLE_REASONS)[number];
}
