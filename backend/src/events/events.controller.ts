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
import type { Event } from '@prisma/client';
import { FacilityContextInterceptor } from '../auth/facility-context.interceptor.js';
import { RequireFacilityGuard, SessionGuard } from '../auth/session.guard.js';
import type { RequestWithAuth } from '../auth/session.guard.js';
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

  @Get()
  @UseGuards(SessionGuard, RequireFacilityGuard)
  @UseInterceptors(FacilityContextInterceptor)
  async list(@Req() req: RequestWithAuth): Promise<EventResponseDto[]> {
    const facilityId = requireFacilityId(req);
    const events = await this.recorder.list(facilityId);
    return events.map(toEventResponseDto);
  }
}

function parseRecordEventRequest(body: RecordEventRequestDto) {
  const cameraId = requireString(body?.camera_id, 'camera_id');
  const type = requireString(body?.type, 'type').trim();
  if (!ALLOWED_EVENT_TYPE_SET.has(type.toLowerCase())) {
    throw new BadRequestException(
      `type must be one of: ${ALLOWED_EVENT_TYPES.join(', ')}`,
    );
  }
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
