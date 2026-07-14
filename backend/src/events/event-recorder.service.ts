import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Event } from '@prisma/client';
import * as crypto from 'crypto';
import { CamerasService } from '../cameras/cameras.service.js';
import { AlertEventTypes } from '../alerts/dto/alert-events.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ListEventsQueryDto } from './dto/event.dto.js';

const ALLOWED_EVENT_TYPES = Object.values(AlertEventTypes);
const ALLOWED_EVENT_TYPE_SET = new Set<string>(ALLOWED_EVENT_TYPES);
export interface RecordEventInput {
  cameraId: string;
  type: string;
  detectedAt: Date;
  confidence?: number;
  configVersion?: number;
  modelVersion?: string;
  detectorVersion?: string;
  operatingThreshold?: number;
  snapshotKey?: string | null;
  clockSource?: string;
  clipId?: string;
}

export interface RecordedEventResult {
  event: Event;
  duplicate: boolean;
}
export interface ListedEventsResult {
  items: Event[];
  nextCursor: string | null;
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
              clipId: input.clipId ?? null,
              configVersion: input.configVersion ?? null,
              modelVersion: input.modelVersion ?? null,
              detectorVersion: input.detectorVersion ?? null,
              operatingThreshold: input.operatingThreshold ?? null,
              // PR-B0(f): snapshot key is ALWAYS server-derived via
              // PUT /events/:eventId/snapshot. Any client-supplied snapshot_key
              // is ignored at create; that upload route is the sole non-null setter.
              snapshotKey: null,
              clockSource: input.clockSource ?? null,
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

  async resolveForSnapshot(
    eventId: string,
  ): Promise<{ id: string; facilityId: string }> {
    const rows = await this.prisma.$queryRaw<
      { id: string; facilityId: string }[]
    >`SELECT id, facility_id AS "facilityId" FROM get_event_for_snapshot(${eventId})`;

    const event = rows[0];
    if (!event) throw new NotFoundException('unknown_event');

    return event;
  }

  async persistSnapshotKey(
    facilityId: string,
    eventId: string,
    snapshotKey: string,
  ): Promise<void> {
    // Existing rows with events.snapshot_key set but alerts.snapshot_key null
    // require a one-time ops backfill script; this request path stays atomic.
    await this.prisma.withFacilityContext(facilityId, async (tx) => {
      await tx.$queryRaw`SELECT set_event_snapshot_key(${eventId}, ${facilityId}, ${snapshotKey})`;
      await tx.alert.updateMany({
        where: { originEventId: eventId },
        data: { snapshotKey },
      });
    });
  }

  async list(
    facilityId: string,
    query: ListEventsQueryDto = {},
  ): Promise<ListedEventsResult> {
    const limit = Math.min(query.limit ?? 50, 200);
    let cursor: { detectedAt: Date; id: string } | null = null;
    if (query.cursor !== undefined && query.cursor !== '') {
      cursor = decodeListCursor(query.cursor);
      if (!cursor) throw new BadRequestException('invalid cursor');
    }

    const where: Prisma.EventWhereInput | undefined = cursor
      ? {
          OR: [
            { detectedAt: { lt: cursor.detectedAt } },
            { detectedAt: cursor.detectedAt, id: { lt: cursor.id } },
          ],
        }
      : undefined;
    const rows = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.event.findMany({
          where,
          orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        }),
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasMore && last ? encodeListCursor(last) : null,
    };
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
function encodeListCursor(event: Pick<Event, 'detectedAt' | 'id'>): string {
  return Buffer.from(`${event.detectedAt.toISOString()}|${event.id}`).toString(
    'base64',
  );
}

function decodeListCursor(
  cursor: string | undefined,
): { detectedAt: Date; id: string } | null {
  if (!cursor) return null;

  try {
    const decoded = Buffer.from(cursor, 'base64');
    if (decoded.toString('base64') !== cursor) return null;

    const value = decoded.toString('utf8');
    const separator = value.indexOf('|');
    if (
      separator <= 0 ||
      separator !== value.lastIndexOf('|') ||
      separator === value.length - 1
    ) {
      return null;
    }

    const detectedAtIso = value.slice(0, separator);
    const id = value.slice(separator + 1);
    const detectedAt = new Date(detectedAtIso);
    if (
      Number.isNaN(detectedAt.getTime()) ||
      detectedAt.toISOString() !== detectedAtIso
    ) {
      return null;
    }

    return { detectedAt, id };
  } catch {
    return null;
  }
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
