import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
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
  const confidence = body.confidence;
  if (confidence !== undefined && typeof confidence !== 'number') {
    throw new BadRequestException('confidence must be a number');
  }
  return { cameraId, type, detectedAt, confidence };
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
  };
}
