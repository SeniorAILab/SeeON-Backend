/**
 * AlertWriterService — serialized alert persistence + SSE emit (F3).
 *
 * All alert inserts funnel through `writeAlert()`. An in-process Promise chain
 * (mutex pattern) serializes inserts so alertSeq assignment, transaction
 * commit, and SSE emission happen in the same causal order.
 *
 * SSE clients subscribe via `subscribe(facilityId, fn)` and receive emitted events
 * for their facility. Unsubscribe by calling the returned cleanup function.
 *
 * After each committed alert, a StatusEvent is emitted via subscribeStatus
 * so SSE streams can deliver `event: status` frames to connected clients
 * (AC5/AC6 live resident status badge).
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ResidentState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AlertEventTypes } from './dto/alert-events.dto.js';

export interface AlertEvent {
  alertSeq: bigint;
  id: string;
  facilityId: string;
  residentId: string | null;
  cameraId: string | null;
  spaceId: string | null;
  type: string;
  probability: number;
  snapshotKey: string | null;
  detectedAt: Date;
  status: string;
  resident?: { name: string } | null;
  space?: { name: string } | null;
  room: string | null;
}
export interface WriteAlertResult extends AlertEvent {
  created: boolean;
}


/** Emitted after each committed alert; carries the new ResidentStatus state. */
export interface StatusEvent {
  alertSeq: bigint;
  facilityId: string;
  residentId: string;
  state: ResidentState;
  cameraOnline: boolean;
  lastSeenAt: Date | null;
}

export interface WriteAlertInput {
  facilityId: string;
  residentId: string | null;
  cameraId: string | null;
  spaceId: string;
  type: string;
  probability: number;
  snapshotKey: string | null;
  detectedAt: Date;
  idempotencyKey: string;
  originEventId?: string | null;
}

const CAMERA_ONLINE_TIMEOUT_MS = 30_000;

type Listener = (event: AlertEvent) => void;
type StatusListener = (event: StatusEvent) => void;

@Injectable()
export class AlertWriterService {
  private readonly _listeners = new Map<string, Set<Listener>>();
  private readonly _statusListeners = new Map<string, Set<StatusListener>>();
  private _queue: Promise<unknown> = Promise.resolve();
  private readonly logger = new Logger(AlertWriterService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Subscribe to live alert SSE events for facilityId.
   * Returns an unsubscribe function.
   */
  subscribe(facilityId: string, fn: Listener): () => void {
    let listeners = this._listeners.get(facilityId);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(facilityId, listeners);
    }
    listeners.add(fn);
    return () => this._listeners.get(facilityId)?.delete(fn);
  }

  /**
   * Subscribe to live status-change events for facilityId (AC5/AC6).
   * Returns an unsubscribe function.
   */
  subscribeStatus(facilityId: string, fn: StatusListener): () => void {
    let listeners = this._statusListeners.get(facilityId);
    if (!listeners) {
      listeners = new Set();
      this._statusListeners.set(facilityId, listeners);
    }
    listeners.add(fn);
    return () => this._statusListeners.get(facilityId)?.delete(fn);
  }

  /**
   * Enqueue an alert write. Returns the committed alert with its alertSeq.
   * Serialized: each call runs only after the previous one has committed.
   * F3: assign alertSeq + commit + emit happen in causal order.
   */
  writeAlert(input: WriteAlertInput): Promise<WriteAlertResult> {
    if (typeof input.spaceId !== 'string' || !input.spaceId.trim()) {
      return Promise.reject(new BadRequestException('spaceId is required'));
    }
    const next = this._queue.then(() => this._doWrite(input));
    // Swallow queue errors to prevent one failure from blocking the chain.
    this._queue = next.catch(() => undefined);
    return next;
  }

  private async _doWrite(input: WriteAlertInput): Promise<WriteAlertResult> {
    const {
      facilityId,
      residentId,
      cameraId,
      spaceId,
      type,
      probability,
      snapshotKey,
      detectedAt,
      idempotencyKey,
      originEventId,
    } = input;

    // Determine new resident state from backend-owned alert policy.
    const newState: ResidentState =
      type === AlertEventTypes.bedExit
        ? ResidentState.WARNING
        : probability >= 0.8
          ? ResidentState.FALL
          : probability >= 0.5
            ? ResidentState.WARNING
            : ResidentState.NORMAL;

    const now = new Date();
    const cameraOnline =
      now.getTime() - detectedAt.getTime() < CAMERA_ONLINE_TIMEOUT_MS;

    const writeResult = await this.prisma.withFacilityContext(
      facilityId,
      async (tx: Prisma.TransactionClient) => {
        const created = await tx.alert.create({
          data: {
            facilityId,
            residentId,
            cameraId: cameraId ?? undefined,
            spaceId: spaceId.trim(),
            type,
            probability,
            snapshotKey,
            detectedAt,
            idempotencyKey,
            originEventId: originEventId ?? undefined,
          },
          include: {
            resident: { select: { name: true } },
            space: { select: { name: true } },
          },
        });

        if (residentId) {
          await tx.residentStatus.upsert({
            where: { residentId },
            update: {
              state: newState,
              lastSeenAt: detectedAt,
              cameraOnline,
              sourceId: cameraId ?? undefined,
            },
            create: {
              residentId,
              facilityId,
              state: newState,
              lastSeenAt: detectedAt,
              cameraOnline,
              sourceId: cameraId ?? undefined,
            },
          });
        }

        return { alert: created, created: true };
      },
    ).catch(async (err: unknown) => {
      if (!isAlertConflict(err)) throw err;
      const existing = await this.findExistingAlert(facilityId, idempotencyKey, originEventId);
      if (!existing) throw err;
      return { alert: existing, created: false };
    });

    const { alert, created } = writeResult;
    if (!created) {
      return { ...toAlertEvent(alert), created: false };
    }

    if (!residentId) {
      this.logger.log({
        event: 'alert.empty_room_written',
        facilityId,
        spaceId: alert.spaceId,
        cameraId: alert.cameraId,
        alertId: alert.id,
        alertSeq: alert.alertSeq.toString(),
      });
    }

    const event: AlertEvent = toAlertEvent(alert);

    // Emit alert AFTER commit (F3).
    this._emit(facilityId, event);

    if (residentId) {
      const statusEvent: StatusEvent = {
        alertSeq: alert.alertSeq,
        facilityId,
        residentId,
        state: newState,
        cameraOnline,
        lastSeenAt: detectedAt,
      };
      this._emitStatus(facilityId, statusEvent);
    }

    return { ...event, created: true };
  }

  private async findExistingAlert(
    facilityId: string,
    idempotencyKey: string,
    originEventId: string | null | undefined,
  ) {
    return this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.alert.findFirst({
          where: {
            facilityId,
            OR: [
              { idempotencyKey },
              ...(originEventId ? [{ originEventId }] : []),
            ],
          },
          include: {
            resident: { select: { name: true } },
            space: { select: { name: true } },
          },
          orderBy: { alertSeq: 'asc' },
        }),
    );
  }

  private _emit(facilityId: string, event: AlertEvent): void {
    const listeners = this._listeners.get(facilityId);
    if (!listeners) return;
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        // listener errors must not crash the writer
      }
    }
  }

  private _emitStatus(facilityId: string, event: StatusEvent): void {
    const listeners = this._statusListeners.get(facilityId);
    if (!listeners) return;
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        // listener errors must not crash the writer
      }
    }
  }
}

function toAlertEvent(alert: {
  alertSeq: bigint;
  id: string;
  facilityId: string;
  residentId: string | null;
  cameraId: string | null;
  spaceId: string;
  type: string;
  probability: number;
  snapshotKey: string | null;
  detectedAt: Date;
  status: string;
  resident: { name: string } | null;
  space: { name: string };
}): AlertEvent {
  return {
    alertSeq: alert.alertSeq,
    id: alert.id,
    facilityId: alert.facilityId,
    residentId: alert.residentId,
    cameraId: alert.cameraId,
    spaceId: alert.spaceId,
    type: alert.type,
    probability: alert.probability,
    snapshotKey: alert.snapshotKey,
    detectedAt: alert.detectedAt,
    status: alert.status,
    resident: alert.resident,
    space: alert.space,
    room: alert.space.name,
  };
}

function isAlertConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== 'P2002') return false;
  const target = err.meta?.target;
  return (
    target === null ||
    typeof target === 'string' ||
    (Array.isArray(target) &&
      target.includes('facility_id') &&
      (target.includes('idempotency_key') || target.includes('origin_event_id')))
  );
}
