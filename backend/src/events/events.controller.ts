import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';
import type { Event } from '@prisma/client';
import { FacilityContextInterceptor } from '../auth/facility-context.interceptor.js';
import { RequireFacilityGuard, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { RequestWithAuth } from '../auth/jwt-auth.guard.js';
import { AlertEventTypes } from '../alerts/dto/alert-events.dto.js';
import type {
  EventResponseDto,
  RecordEventRequestDto,
  RecordHeartbeatRequestDto,
  RecordHeartbeatResponseDto,
  RecordEventResponseDto,
} from './dto/event.dto.js';
import { CamerasService } from '../cameras/cameras.service.js';
import { EventAlarmService } from './event-alarm.service.js';
import { EventRecorderService } from './event-recorder.service.js';
import {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_EXTENSIONS,
  readRequestBody,
  resolveSnapshotPath,
  snapshotRoot,
} from '../common/snapshot-storage.js';

const ALLOWED_EVENT_TYPES = Object.values(AlertEventTypes);
const ALLOWED_EVENT_TYPE_SET = new Set(
  ALLOWED_EVENT_TYPES.map((type) => type.toLowerCase()),
);

@Controller({ path: 'events', version: '1' })
export class EventsController {
  constructor(
    private readonly eventAlarm: EventAlarmService,
    private readonly recorder: EventRecorderService,
    private readonly cameras: CamerasService,
  ) {}

  @ApiOperation({
    summary: 'Record an ML event',
    description:
      'Accepts camera-keyed ML events, resolves the facility and space from camera ownership, persists the event, and creates alerts for alert-worthy types.',
  })
  @Post()
  async record(
    @Body() body: RecordEventRequestDto,
  ): Promise<RecordEventResponseDto> {
    const input = parseRecordEventRequest(body);
    const result = await this.eventAlarm.record(input);
    return {
      id: result.event.id,
      status: result.duplicate ? 'duplicate' : 'created',
    };
  }

  @ApiOperation({
    summary: 'Record camera heartbeat',
    description:
      'Marks the resolved camera online from an ML heartbeat without creating an alert.',
  })
  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(
    @Body() body: RecordHeartbeatRequestDto,
  ): Promise<RecordHeartbeatResponseDto> {
    const cameraId = requireString(body?.camera_id, 'camera_id');
    const camera = await this.cameras.resolveForEventIngest(cameraId);
    await this.cameras.recordHeartbeat(camera.facilityId, camera.id);
    return { ok: true };
  }

  @ApiOperation({
    summary: 'Upload an event snapshot',
    description:
      'Stores raw event snapshot bytes under a server-derived key after resolving event ownership.',
  })
  @Put(':eventId/snapshot')
  @HttpCode(201)
  async uploadSnapshot(
    @Req() req: RequestWithAuth,
    @Param('eventId') eventId: string,
  ) {
    rejectClientSuppliedSnapshotKey(req);

    const contentType = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const extension = SNAPSHOT_EXTENSIONS.get(contentType);
    if (!extension) {
      throw new BadRequestException('Unsupported snapshot content type');
    }

    const event = await this.recorder.resolveForSnapshot(eventId);
    const body = await readRequestBody(req, MAX_SNAPSHOT_BYTES);
    if (body.length === 0) throw new BadRequestException('Snapshot is empty');

    const snapshotKey = path.posix.join(
      event.facilityId,
      `${event.id}.${extension}`,
    );
    const filePath = resolveSnapshotPath(snapshotRoot(), snapshotKey);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, body);
    await this.recorder.persistSnapshotKey(
      event.facilityId,
      event.id,
      snapshotKey,
    );

    return { snapshotKey };
  }

  @ApiOperation({
    summary: 'List recorded events',
    description: `Returns the authenticated facility's recorded ML event history for operational review.`,
  })
  @Get()
  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard, RequireFacilityGuard)
  @UseInterceptors(FacilityContextInterceptor)
  async list(@Req() req: RequestWithAuth): Promise<EventResponseDto[]> {
    const facilityId = requireFacilityId(req);
    const events = await this.recorder.list(facilityId);
    return events.map(toEventResponseDto);
  }
}

function parseRecordEventRequest(body: RecordEventRequestDto) {
  const cameraId = requireString(body?.camera_id, 'camera_id');
  const type = normalizeEventType(requireString(body?.type, 'type'));
  const detectedAtRaw = requireString(body?.detected_at, 'detected_at');
  const detectedAt = new Date(detectedAtRaw);
  if (Number.isNaN(detectedAt.getTime())) {
    throw new BadRequestException('detected_at must be a valid timestamp');
  }
  const confidence = optionalNumber(body.confidence, 'confidence');
  const configVersion = optionalNumber(body.config_version, 'config_version');
  const modelVersion = optionalString(body.model_version, 'model_version');
  const detectorVersion = optionalString(
    body.detector_version,
    'detector_version',
  );
  const operatingThreshold = optionalNumber(
    body.operating_threshold,
    'operating_threshold',
  );
  const snapshotKey = optionalNullableString(body.snapshot_key, 'snapshot_key');
  const clockSource = optionalString(body.clock_source, 'clock_source');
  return {
    cameraId,
    type,
    detectedAt,
    confidence,
    configVersion,
    modelVersion,
    detectorVersion,
    operatingThreshold,
    snapshotKey,
    clockSource,
  };
}

function normalizeEventType(rawType: string): string {
  const type = rawType.trim().toLowerCase();
  if (!ALLOWED_EVENT_TYPE_SET.has(type)) {
    throw new BadRequestException(
      `type must be one of: ${ALLOWED_EVENT_TYPES.join(', ')}`,
    );
  }
  return type;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} is required`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') {
    throw new BadRequestException(`${field} must be a number`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  return value;
}

function optionalNullableString(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string or null`);
  }
  return value;
}

function rejectClientSuppliedSnapshotKey(req: RequestWithAuth): void {
  const query = req.query as Record<string, unknown> | undefined;
  if (
    query &&
    (Object.prototype.hasOwnProperty.call(query, 'snapshotKey') ||
      Object.prototype.hasOwnProperty.call(query, 'snapshot_key'))
  ) {
    throw new BadRequestException('snapshot key is server-derived');
  }

  const headers = req.headers as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(headers, 'snapshotkey') ||
    Object.prototype.hasOwnProperty.call(headers, 'snapshot_key') ||
    Object.prototype.hasOwnProperty.call(headers, 'snapshot-key') ||
    Object.prototype.hasOwnProperty.call(headers, 'x-snapshot-key')
  ) {
    throw new BadRequestException('snapshot key is server-derived');
  }

  const body = (req as { body?: unknown }).body;
  if (body && typeof body === 'object') {
    const bodyRecord = body as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(bodyRecord, 'snapshotKey') ||
      Object.prototype.hasOwnProperty.call(bodyRecord, 'snapshot_key') ||
      Object.prototype.hasOwnProperty.call(bodyRecord, 'key')
    ) {
      throw new BadRequestException('snapshot key is server-derived');
    }
  }
}

function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}

function toEventResponseDto(event: Event): EventResponseDto {
  return {
    id: event.id,
    facilityId: event.facilityId,
    cameraId: event.cameraId,
    spaceId: event.spaceId,
    type: event.type,
    confidence: event.confidence,
    detectedAt: event.detectedAt,
    createdAt: event.createdAt,
    modifiedAt: event.modifiedAt,
    configVersion: event.configVersion,
    modelVersion: event.modelVersion,
    detectorVersion: event.detectorVersion,
    operatingThreshold: event.operatingThreshold,
    snapshotKey: event.snapshotKey,
    clockSource: event.clockSource,
  };
}
