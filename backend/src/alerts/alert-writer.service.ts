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
 * Room-centric: alerts are keyed by space/room only and SSE emits alert
 * creation/lifecycle frames.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AlertStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { FacilityScopedNotFoundException } from '../common/domain-errors.js';
import {
  alertInclude,
  presentAlert,
  type AlertWithContext,
} from './alerts.presenter.js';

export interface AlertEvent {
  alertSeq: bigint;
  id: string;
  facilityId: string;
  cameraId: string | null;
  spaceId: string | null;
  type: string;
  probability: number;
  snapshotKey: string | null;
  detectedAt: Date;
  status: string;
  space?: { name: string } | null;
  room: string | null;
}
export interface WriteAlertResult extends AlertEvent {
  created: boolean;
}

/** Emitted after an alert lifecycle transition (ack/resolve) commits. Live-only, non-replayed. */
export interface AlertUpdateEvent {
  alertSeq: bigint;
  id: string;
  facilityId: string;
  status: string;
  spaceId: string;
  ackedById: string | null;
  ackedAt: Date | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
}

export interface WriteAlertInput {
  facilityId: string;
  cameraId: string | null;
  spaceId: string;
  type: string;
  probability: number;
  snapshotKey: string | null;
  detectedAt: Date;
  idempotencyKey: string;
  originEventId?: string | null;
}

type Listener = (event: AlertEvent) => void;
type UpdateListener = (event: AlertUpdateEvent) => void;

@Injectable()
export class AlertWriterService {
  private readonly _listeners = new Map<string, Set<Listener>>();
  private readonly _updateListeners = new Map<string, Set<UpdateListener>>();
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
      cameraId,
      spaceId,
      type,
      probability,
      snapshotKey,
      detectedAt,
      idempotencyKey,
      originEventId,
    } = input;

    const writeResult = await this.prisma
      .withFacilityContext(facilityId, async (tx: Prisma.TransactionClient) => {
        const created = await tx.alert.create({
          data: {
            facilityId,
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
            space: { select: { name: true } },
          },
        });

        return { alert: created, created: true };
      })
      .catch(async (err: unknown) => {
        if (!isAlertConflict(err)) throw err;
        const existing = await this.findExistingAlert(
          facilityId,
          idempotencyKey,
          originEventId,
        );
        if (!existing) throw err;
        return { alert: existing, created: false };
      });

    const { alert, created } = writeResult;
    if (!created) {
      return { ...toAlertEvent(alert), created: false };
    }

    this.logger.log({
      event: 'alert.room_written',
      facilityId,
      spaceId: alert.spaceId,
      cameraId: alert.cameraId,
      alertId: alert.id,
      alertSeq: alert.alertSeq.toString(),
    });

    const event: AlertEvent = toAlertEvent(alert);

    // Emit alert AFTER commit (F3).
    this._emit(facilityId, event);

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

  /**
   * Subscribe to live alert lifecycle update events (ack/resolve) for facilityId.
   * Returns an unsubscribe function.
   */
  subscribeUpdates(facilityId: string, fn: UpdateListener): () => void {
    let listeners = this._updateListeners.get(facilityId);
    if (!listeners) {
      listeners = new Set();
      this._updateListeners.set(facilityId, listeners);
    }
    listeners.add(fn);
    return () => this._updateListeners.get(facilityId)?.delete(fn);
  }

  /**
   * Acknowledge an alert (NEW → ACKED), stamping the session actor + time.
   * Serialized on the same queue as inserts. Idempotent for an already-ACKED
   * alert (no restamp); rejects an already-RESOLVED alert with 409.
   */
  ackAlert(input: {
    facilityId: string;
    alertId: string;
    actorUserId: string;
  }): Promise<ReturnType<typeof presentAlert>> {
    const next = this._queue.then(() => this._transition('ack', input));
    this._queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Resolve an alert (NEW/ACKED → RESOLVED), stamping the session actor + time.
   * Idempotent for an already-RESOLVED alert (no restamp).
   */
  resolveAlert(input: {
    facilityId: string;
    alertId: string;
    actorUserId: string;
  }): Promise<ReturnType<typeof presentAlert>> {
    const next = this._queue.then(() => this._transition('resolve', input));
    this._queue = next.catch(() => undefined);
    return next;
  }

  private async _transition(
    kind: 'ack' | 'resolve',
    {
      facilityId,
      alertId,
      actorUserId,
    }: { facilityId: string; alertId: string; actorUserId: string },
  ): Promise<ReturnType<typeof presentAlert>> {
    const { alert, changed } = await this.prisma.withFacilityContext(
      facilityId,
      async (
        tx: Prisma.TransactionClient,
      ): Promise<{ alert: AlertWithContext; changed: boolean }> => {
        const existing = await tx.alert.findUnique({ where: { id: alertId } });
        if (!existing) throw new FacilityScopedNotFoundException('alert');

        const data =
          kind === 'ack'
            ? this._ackData(existing.status, actorUserId)
            : this._resolveData(existing.status, actorUserId);

        if (data === null) {
          // Idempotent no-op: return the current row without restamping.
          const current = await tx.alert.findUnique({
            where: { id: alertId },
            include: alertInclude,
          });
          return { alert: current as AlertWithContext, changed: false };
        }

        const updated = await tx.alert.update({
          where: { id: alertId },
          data,
          include: alertInclude,
        });
        return { alert: updated, changed: true };
      },
    );

    if (changed) {
      // Emit AFTER commit (live-only, non-replayed lifecycle delta).
      this._emitUpdate(facilityId, {
        alertSeq: alert.alertSeq,
        id: alert.id,
        facilityId: alert.facilityId,
        spaceId: alert.spaceId,
        status: alert.status,
        ackedById: alert.ackedById,
        ackedAt: alert.ackedAt,
        resolvedById: alert.resolvedById,
        resolvedAt: alert.resolvedAt,
      });
    }
    return presentAlert(alert);
  }

  private _ackData(
    status: AlertStatus,
    actorUserId: string,
  ): Prisma.AlertUncheckedUpdateInput | null {
    if (status === AlertStatus.ACKED) return null; // idempotent no-op
    if (status === AlertStatus.RESOLVED)
      throw new ConflictException('Alert already resolved');
    return {
      status: AlertStatus.ACKED,
      ackedById: actorUserId,
      ackedAt: new Date(),
    };
  }

  private _resolveData(
    status: AlertStatus,
    actorUserId: string,
  ): Prisma.AlertUncheckedUpdateInput | null {
    if (status === AlertStatus.RESOLVED) return null; // idempotent no-op
    return {
      status: AlertStatus.RESOLVED,
      resolvedById: actorUserId,
      resolvedAt: new Date(),
    };
  }

  private _emitUpdate(facilityId: string, event: AlertUpdateEvent): void {
    const listeners = this._updateListeners.get(facilityId);
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
  cameraId: string | null;
  spaceId: string;
  type: string;
  probability: number;
  snapshotKey: string | null;
  detectedAt: Date;
  status: string;
  space: { name: string };
}): AlertEvent {
  return {
    alertSeq: alert.alertSeq,
    id: alert.id,
    facilityId: alert.facilityId,
    cameraId: alert.cameraId,
    spaceId: alert.spaceId,
    type: alert.type,
    probability: alert.probability,
    snapshotKey: alert.snapshotKey,
    detectedAt: alert.detectedAt,
    status: alert.status,
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
      (target.includes('idempotency_key') ||
        target.includes('origin_event_id')))
  );
}
