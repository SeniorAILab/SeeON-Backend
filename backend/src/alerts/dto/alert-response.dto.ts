import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

const ALERT_STATUSES = ['NEW', 'ACKED', 'RESOLVED'] as const;

export class AlertActor {
  @ApiProperty()
  nickname!: string;
}

export class AlertSpace {
  @ApiProperty()
  name!: string;
}

@ApiExtraModels(AlertActor, AlertSpace)
export class Alert {
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
    oneOf: [{ $ref: getSchemaPath(AlertActor) }, { type: 'null' }],
  })
  ackedBy!: AlertActor | null;

  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'null' }] })
  resolvedById!: string | null;

  @ApiProperty({
    oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
  })
  resolvedAt!: Date | null;

  @ApiProperty({
    oneOf: [{ $ref: getSchemaPath(AlertActor) }, { type: 'null' }],
  })
  resolvedBy!: AlertActor | null;

  @ApiProperty({ type: AlertSpace })
  space!: AlertSpace;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class AlertNote {
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

@ApiExtraModels(AlertNote)
export class AlertDetail extends Alert {
  @ApiProperty({ type: [AlertNote] })
  notes!: AlertNote[];
}

export class AlertSseData {
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

export class AlertUpdatedSseData {
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
