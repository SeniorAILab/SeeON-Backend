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
import { EdgeIngestTokenGuard } from './edge-ingest-token.guard.js';
import {
  type EventResponseDto,
  RecordEventRequestDto,
  RecordHeartbeatRequestDto,
  type RecordHeartbeatResponseDto,
  type RecordEventResponseDto,
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
  @UseGuards(EdgeIngestTokenGuard)
  async record(
    @Body() body: RecordEventRequestDto,
  ): Promise<RecordEventResponseDto> {
    // camera_id trim/blank checks, type canonicalization + enum membership,
    // and detected_at timestamp validity are all independently re-validated
    // by EventRecorderService.record(); the DTO's decorators only guarantee
    // these arrive as the right JS types.
    const result = await this.eventAlarm.record({
      cameraId: body.camera_id,
      type: body.type,
      detectedAt: new Date(body.detected_at),
      confidence: body.confidence,
      configVersion: body.config_version,
      modelVersion: body.model_version,
      detectorVersion: body.detector_version,
      operatingThreshold: body.operating_threshold,
      snapshotKey: body.snapshot_key,
      clockSource: body.clock_source,
      clipId: optionalTrimmedString(body.clip_id),
    });
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
  @UseGuards(EdgeIngestTokenGuard)
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
  @UseGuards(EdgeIngestTokenGuard)
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

// Kept for heartbeat(): cameras.service.ts's resolveForEventIngest() 404s
// (unknown_camera) rather than 400s on a blank camera_id, so this blank
// check cannot be replaced by the DTO's @IsString() alone without changing
// the status code for that edge case.
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} is required`);
  }
  return value;
}


function optionalTrimmedString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
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
    clipId: event.clipId,
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
