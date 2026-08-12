import type { Prisma } from '@prisma/client';
import {
  SYSTEM_TEST_LABEL,
  SYSTEM_TEST_MODE,
  SYSTEM_TEST_TTS_TEXT,
} from '../events/system-test.constants.js';

/**
 * Shared Alert read shape + presenter for the product `/api/v1/alerts` surface
 * and the lifecycle writer. Includes lifecycle audit actors so REST list/get/
 * replay carry current status + who/when for SSE-update recovery.
 */
export const alertInclude = {
  space: { select: { name: true } },
  ackedBy: { select: { nickname: true } },
  resolvedBy: { select: { nickname: true } },
} satisfies Prisma.AlertInclude;

export const alertDetailInclude = {
  ...alertInclude,
  notes: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      note: true,
      createdById: true,
      authorRole: true,
      createdAt: true,
    },
  },
} satisfies Prisma.AlertInclude;

export type AlertWithContext = Prisma.AlertGetPayload<{
  include: typeof alertInclude;
}>;

export type AlertDetailWithContext = Prisma.AlertGetPayload<{
  include: typeof alertDetailInclude;
}>;

export function presentAlert(alert: AlertWithContext) {
  const systemTest = alert.type === SYSTEM_TEST_MODE;
  return {
    alertSeq: alert.alertSeq.toString(),
    id: alert.id,
    backendEventId: alert.originEventId,
    facilityId: alert.facilityId,
    cameraId: alert.cameraId,
    spaceId: alert.spaceId,
    room: systemTest ? null : (alert.space?.name ?? null),
    type: alert.type,
    ...(systemTest
      ? {
          source: SYSTEM_TEST_MODE,
          residentId: null,
          testMode: SYSTEM_TEST_MODE,
          label: SYSTEM_TEST_LABEL,
          ttsText: SYSTEM_TEST_TTS_TEXT,
        }
      : {}),
    probability: alert.probability,
    snapshotKey: alert.snapshotKey,
    detectedAt: alert.detectedAt,
    status: alert.status,
    ackedById: alert.ackedById,
    ackedAt: alert.ackedAt,
    ackedBy: alert.ackedBy,
    resolvedById: alert.resolvedById,
    resolvedAt: alert.resolvedAt,
    resolvedBy: alert.resolvedBy,
    space: alert.space,
    createdAt: alert.createdAt,
  };
}

export function presentAlertDetail(alert: AlertDetailWithContext) {
  return {
    ...presentAlert(alert),
    notes: alert.notes.map((note) => ({
      id: note.id,
      note: note.note,
      createdBy: note.createdById,
      authorRole: note.authorRole,
      createdAt: note.createdAt,
    })),
  };
}
