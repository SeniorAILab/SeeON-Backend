import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type Event } from '@prisma/client';
import * as crypto from 'crypto';
import { CamerasService } from '../cameras/cameras.service.js';
import { AlertEventTypes } from '../alerts/dto/alert-events.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';

const ALLOWED_EVENT_TYPES = Object.values(AlertEventTypes);
const ALLOWED_EVENT_TYPE_SET = new Set<string>(ALLOWED_EVENT_TYPES);
export interface RecordEventInput {
  cameraId: string;
  type: string;
  detectedAt: Date;
  confidence?: number;
}

export interface RecordedEventResult {
  event: Event;
  duplicate: boolean;
}

@Injectable()
export class EventRecorderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cameras: CamerasService,
  ) {}

  async record(input: RecordEventInput): Promise<RecordedEventResult> {
    const cameraId = input.cameraId.trim();
    const type = normalizeEventType(input.type);
    if (!cameraId) throw new BadRequestException('camera_id is required');
    if (Number.isNaN(input.detectedAt.getTime())) {
      throw new BadRequestException('detected_at must be a valid timestamp');
    }
    if (input.confidence !== undefined && !Number.isFinite(input.confidence)) {
      throw new BadRequestException('confidence must be a finite number');
    }

    const camera = await this.cameras.resolveForEventIngest(cameraId);
    const detectedAt = input.detectedAt;
    const dedupKey = buildEventDedupKey(cameraId, detectedAt, type);

    try {
      const event = await this.prisma.withFacilityContext(
        camera.facilityId,
        (tx) =>
          tx.event.create({
            data: {
              facilityId: camera.facilityId,
              cameraId: camera.id,
              spaceId: camera.spaceId,
              type,
              confidence: input.confidence,
              detectedAt,
              dedupKey,
            },
          }),
      );
      return { event, duplicate: false };
    } catch (err: unknown) {
      if (!isDedupConflict(err)) throw err;
      const existing = await this.prisma.withFacilityContext(
        camera.facilityId,
        (tx) =>
          tx.event.findUniqueOrThrow({
            where: {
              facilityId_dedupKey: { facilityId: camera.facilityId, dedupKey },
            },
          }),
      );
      return { event: existing, duplicate: true };
    }
  }

  async list(facilityId: string): Promise<Event[]> {
    return this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.event.findMany({ orderBy: { detectedAt: 'desc' } }),
    );
  }
}

export function buildEventDedupKey(
  cameraId: string,
  detectedAt: Date,
  type: string,
): string {
  return crypto
    .createHash('sha256')
    .update(
      `${cameraId.trim()}|${detectedAt.toISOString()}|${type.trim().toLowerCase()}`,
    )
    .digest('hex');
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

function isDedupConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== 'P2002') return false;
  const target = err.meta?.target;
  return (
    target === null ||
    (Array.isArray(target) &&
      target.includes('facility_id') &&
      target.includes('dedup_key'))
  );
}
