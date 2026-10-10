import {
  ApiExtraModels,
  ApiProperty,
  ApiSchema,
  getSchemaPath,
} from '@nestjs/swagger';

const ALERT_STATUSES = ['NEW', 'ACKED', 'RESOLVED'] as const;

@ApiSchema({ name: 'AlertActor' })
export class AlertActorDto {
  @ApiProperty()
  nickname!: string;
}

@ApiSchema({ name: 'AlertSpace' })
export class AlertSpaceDto {
  @ApiProperty()
  name!: string;
}

@ApiExtraModels(AlertActorDto, AlertSpaceDto)
@ApiSchema({ name: 'Alert' })
export class AlertResponseDto {
  @ApiProperty({ pattern: '^[0-9]+$' })
  alertSeq!: string;

  @ApiProperty()
  id!: string;

  @ApiProperty()
  backendEventId!: string;

  @ApiProperty()
  facilityId!: string;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'null' }] })
  cameraId!: string | null;

  @ApiProperty()
  spaceId!: string;

  @ApiProperty()
  room!: string;

  @ApiProperty()
  type!: string;

  @ApiProperty()
  probability!: number;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'null' }] })
  snapshotKey!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  detectedAt!: Date;

  @ApiProperty({ enum: ALERT_STATUSES })
  status!: (typeof ALERT_STATUSES)[number];

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'null' }] })
  ackedById!: string | null;

  @ApiProperty({
    oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
  })
  ackedAt!: Date | null;

  @ApiProperty({
    oneOf: [{ $ref: getSchemaPath(AlertActorDto) }, { type: 'null' }],
  })
  ackedBy!: AlertActorDto | null;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'null' }] })
  resolvedById!: string | null;

  @ApiProperty({
    oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
  })
  resolvedAt!: Date | null;

  @ApiProperty({
    oneOf: [{ $ref: getSchemaPath(AlertActorDto) }, { type: 'null' }],
  })
  resolvedBy!: AlertActorDto | null;

  @ApiProperty({ type: AlertSpaceDto })
  space!: AlertSpaceDto;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

@ApiSchema({ name: 'AlertNote' })
export class AlertNoteResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  note!: string;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'null' }] })
  createdBy!: string | null;

  @ApiProperty({ enum: ['ADMIN', 'STAFF'] })
  authorRole!: 'ADMIN' | 'STAFF';

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

@ApiExtraModels(AlertNoteResponseDto)
@ApiSchema({ name: 'AlertDetail' })
export class AlertDetailResponseDto extends AlertResponseDto {
  @ApiProperty({ type: [AlertNoteResponseDto] })
  notes!: AlertNoteResponseDto[];
}

@ApiSchema({ name: 'AlertSseData' })
export class AlertSseDataDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  backendEventId!: string;

  @ApiProperty({ pattern: '^[0-9]+$' })
  alertSeq!: string;

  @ApiProperty()
  facilityId!: string;

  @ApiProperty()
  spaceId!: string;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'null' }] })
  cameraId!: string | null;

  @ApiProperty()
  type!: string;

  @ApiProperty({ enum: ALERT_STATUSES })
  status!: (typeof ALERT_STATUSES)[number];

  @ApiProperty()
  probability!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  detectedAt!: Date;
}

@ApiSchema({ name: 'AlertUpdatedSseData' })
export class AlertUpdatedSseDataDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ pattern: '^[0-9]+$' })
  alertSeq!: string;

  @ApiProperty()
  spaceId!: string;

  @ApiProperty({ enum: ['ACKED', 'RESOLVED'] })
  status!: 'ACKED' | 'RESOLVED';

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'null' }] })
  resolvedById!: string | null;

  @ApiProperty({
    oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
  })
  resolvedAt!: Date | null;
}
