import type { Event, Prisma } from '@prisma/client';
import {
  EVENT_MEDIA_ERROR_CODES,
  EventMediaError,
  type ReadyClipManifest,
} from './event-media.types.js';
import {
  immutableConflict,
  sameOrderedBindings,
} from './event-media-repository.helpers.js';

type EventIdentity = Pick<Event, 'id' | 'edgeEventId' | 'cameraId'>;

export async function requireOwnedEvents(
  tx: Prisma.TransactionClient,
  input: Pick<ReadyClipManifest, 'cameraId' | 'eventRefs'>,
): Promise<readonly EventIdentity[]> {
  const events = await tx.event.findMany({
    where: { edgeEventId: { in: [...input.eventRefs] } },
    select: { id: true, edgeEventId: true, cameraId: true },
  });
  const byEdgeEventId = new Map<string, EventIdentity>();
  for (const event of events) {
    if (event.edgeEventId !== null) byEdgeEventId.set(event.edgeEventId, event);
  }
  const ordered: EventIdentity[] = [];
  for (const edgeEventId of input.eventRefs) {
    const event = byEdgeEventId.get(edgeEventId);
    if (event === undefined || event.cameraId !== input.cameraId) {
      throw new EventMediaError(
        EVENT_MEDIA_ERROR_CODES.EVENT_OWNERSHIP,
        'event references do not belong to the resolved camera facility',
      );
    }
    ordered.push(event);
  }
  return ordered;
}

export async function bindExactEvents(
  tx: Prisma.TransactionClient,
  facilityId: string,
  clipId: string,
  events: readonly EventIdentity[],
): Promise<void> {
  const expected = events.map((event, ordinal) => ({
    eventId: event.id,
    ordinal,
  }));
  const eventIds = expected.map((binding) => binding.eventId);
  const current = await tx.eventMediaBinding.findMany({
    where: { clipId },
    select: { eventId: true, ordinal: true },
    orderBy: { ordinal: 'asc' },
  });
  if (current.length > 0 && !sameOrderedBindings(current, expected)) {
    throw immutableConflict();
  }
  const occupied = await tx.eventMediaBinding.findMany({
    where: { eventId: { in: eventIds } },
    select: { eventId: true, clipId: true },
  });
  if (occupied.some((row) => row.clipId !== clipId)) throw immutableConflict();
  await tx.eventMediaBinding.createMany({
    data: expected.map((binding) => ({
      ...binding,
      facilityId,
      clipId,
    })),
    skipDuplicates: true,
  });
  const bound = await tx.eventMediaBinding.findMany({
    where: { clipId },
    select: { eventId: true, ordinal: true },
    orderBy: { ordinal: 'asc' },
  });
  if (!sameOrderedBindings(bound, expected)) throw immutableConflict();
}

export async function lockClip(
  tx: Prisma.TransactionClient,
  clipId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM media_clips WHERE id = ${clipId} FOR UPDATE`;
}
