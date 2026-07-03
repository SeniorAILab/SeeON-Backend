/**
 * GET /api/v1/dashboard/stream — dashboard SSE event stream (F3/F8/F10/F13).
 *
 * Auth: JwtAuthGuard + RequireFacilityGuard (same as data routes).
 * Last-Event-ID: parsed as bigint alertSeq. On reconnect:
 *   1. Replay facility-scoped alerts WHERE alertSeq > lastEventId ORDER BY alertSeq.
 *   2. Live events stream via AlertWriterService.subscribe (alerts) and
 *      AlertWriterService.subscribeUpdates (lifecycle updates).
 *
 * Room-centric stream emits only named `alert` and `alert-updated` frames.
 *
 * F6/AC4: re-auth tick every SSE_REAUTH_INTERVAL_MS ms. Re-validates
 *   user sessionVersion. If invalid, closes stream.
 *   Token is injectable for test override.
 *
 * F10 (no buffering): sets X-Accel-Buffering: no, Cache-Control: no-cache.
 * F13: SSE id field = alertSeq (bigint), NOT the cuid pk.
 *
 * Connection kept alive with 20 s comment heartbeats.
 * SSE closes when client disconnects (req 'close' event).
 */
import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequireFacilityGuard, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { RequestWithAuth } from '../auth/jwt-auth.guard.js';
import { AlertWriterService } from '../alerts/alert-writer.service.js';
import type {
  AlertEvent,
  AlertUpdateEvent,
} from '../alerts/alert-writer.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { AuthService } from '../auth/auth.service.js';

/** Injection token for the SSE re-auth tick interval (ms). Override in tests. */
export const SSE_REAUTH_INTERVAL_MS = 'SSE_REAUTH_INTERVAL_MS';

const HEARTBEAT_MS = 20_000;

@Controller({ path: 'dashboard', version: '1' })
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, RequireFacilityGuard)
export class DashboardStreamController {
  constructor(
    private readonly writer: AlertWriterService,
    private readonly alerts: AlertsService,
    private readonly auth: AuthService,
    @Inject(SSE_REAUTH_INTERVAL_MS)
    private readonly reAuthIntervalMs: number,
  ) {}

  @ApiOperation({
    summary: 'Stream live dashboard alerts',
    description:
      'Opens the facility-scoped SSE stream that emits only room-centric alert and alert-updated frames plus session-invalid control frames.',
  })
  @Get('stream')
  @Header('content-type', 'text/event-stream')
  @Header('cache-control', 'no-cache')
  @Header('connection', 'keep-alive')
  @Header('x-accel-buffering', 'no') // F10: disable Nginx/proxy buffering
  async sse(@Req() req: RequestWithAuth, @Res() res: Response): Promise<void> {
    const facilityId = requireFacilityId(req);

    // Capture session identity at connection time (set by JwtAuthGuard).
    const userId = requireUserId(req);
    const sessionVersion = requireSessionVersion(req);

    res.flushHeaders();

    const write = (chunk: string) => {
      try {
        res.write(chunk);
        // Flush if available (compression/buffering bypass).
        if (
          typeof (res as unknown as { flush?: () => void }).flush === 'function'
        ) {
          (res as unknown as { flush: () => void }).flush();
        }
      } catch {
        // ignore write errors (client disconnected)
      }
    };

    // Initial comment to establish connection.
    write(': connected\n\n');

    // Subscribe before replay to close the replay/live handoff gap.
    let replayHighWatermark = 0n;
    let liveReady = false;
    const liveBuffer: AlertEvent[] = [];
    const updateLiveBuffer: AlertUpdateEvent[] = [];

    const unsub = this.writer.subscribe(facilityId, (event: AlertEvent) => {
      if (!liveReady) {
        liveBuffer.push(event);
        return;
      }
      write(formatAlertEvent(event));
    });

    // Subscribe to lifecycle update events (ack/resolve) — buffer during replay.
    const unsubUpdates = this.writer.subscribeUpdates(
      facilityId,
      (event: AlertUpdateEvent) => {
        if (!liveReady) {
          updateLiveBuffer.push(event);
          return;
        }
        write(formatAlertUpdateEvent(event));
      },
    );

    const failBeforeLive = (eventName: string) => {
      write(`event: ${eventName}\ndata: {}\n\n`);
      unsub();
      unsubUpdates();
      try {
        res.end();
      } catch {
        /* ignore */
      }
    };

    // Replay backlog (F8 Last-Event-ID). Invalid cursors skip replay; replay failures fail visibly.
    const lastEventIdHeader = req.headers['last-event-id'];
    let lastSeq: bigint | null = null;
    if (lastEventIdHeader) {
      try {
        lastSeq = BigInt(String(lastEventIdHeader));
      } catch {
        lastSeq = null;
      }
    }
    if (lastSeq !== null) {
      replayHighWatermark = lastSeq;
      try {
        const backlog = await this.alerts.replay(facilityId, lastSeq);
        for (const alert of backlog) {
          if (alert.alertSeq > replayHighWatermark) {
            replayHighWatermark = alert.alertSeq;
          }
          write(formatAlertEvent(alert));
        }
      } catch {
        failBeforeLive('replay-error');
        return;
      }
    }

    liveReady = true;

    // Flush alert live buffer.
    for (const event of liveBuffer) {
      if (event.alertSeq > replayHighWatermark) {
        write(formatAlertEvent(event));
      }
    }
    liveBuffer.length = 0;

    // Flush alert-updated live buffer. Lifecycle updates are NOT replay-cursor
    // bound, so emit every buffered frame (no alertSeq filtering, no id: line).
    for (const event of updateLiveBuffer) {
      write(formatAlertUpdateEvent(event));
    }
    updateLiveBuffer.length = 0;

    // Heartbeat to keep connection alive.
    const heartbeat = setInterval(() => write(': heartbeat\n\n'), HEARTBEAT_MS);

    // Re-auth tick holder — assigned below after cleanup is defined.
    let reAuthTick: ReturnType<typeof setInterval> | null = null;

    // Cleanup on client disconnect or session invalidation.
    const cleanup = () => {
      clearInterval(heartbeat);
      if (reAuthTick !== null) clearInterval(reAuthTick);
      unsub();
      unsubUpdates();
      try {
        res.end();
      } catch {
        /* ignore */
      }
    };

    req.socket.on('close', cleanup);
    req.on('close', cleanup);

    // F6/AC4: periodic session re-validation.
    reAuthTick = setInterval(() => {
      void (async () => {
        try {
          const active = await this.auth.isSessionVersionCurrent(
            userId,
            sessionVersion,
          );
          if (!active) {
            write('event: session-invalid\ndata: {}\n\n');
            cleanup();
          }
        } catch {
          write('event: session-invalid\ndata: {}\n\n');
          cleanup();
        }
      })();
    }, this.reAuthIntervalMs);
  }
}

type SseAlertLike = Pick<
  AlertEvent,
  | 'alertSeq'
  | 'id'
  | 'cameraId'
  | 'spaceId'
  | 'type'
  | 'probability'
  | 'detectedAt'
  | 'status'
>;

export function formatAlertEvent(event: SseAlertLike): string {
  return formatSseEvent(event.alertSeq, {
    id: event.id,
    alertSeq: event.alertSeq.toString(),
    spaceId: event.spaceId,
    cameraId: event.cameraId,
    type: event.type,
    status: event.status,
    probability: event.probability,
    detectedAt: event.detectedAt,
  });
}

/**
 * Format a named `event: alert-updated` SSE frame (live-only lifecycle delta).
 * MUST NOT include an `id:` line: status changes do not mint a new alertSeq, so
 * reusing it as the SSE id would corrupt Last-Event-ID replay. alertSeq lives in
 * `data` only for client correlation; missed updates are recovered via REST.
 */
export function formatAlertUpdateEvent(event: AlertUpdateEvent): string {
  return (
    `event: alert-updated\n` +
    `data: ${JSON.stringify({
      id: event.id,
      alertSeq: event.alertSeq.toString(),
      spaceId: event.spaceId,
      status: event.status,
      resolvedById: event.resolvedById,
      resolvedAt: event.resolvedAt,
    })}\n\n`
  );
}

function formatSseEvent(
  alertSeq: bigint,
  data: Record<string, unknown>,
): string {
  return `id: ${alertSeq}\nevent: alert\ndata: ${JSON.stringify(data)}\n\n`;
}

function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}

function requireUserId(req: RequestWithAuth): string {
  const userId = req.user?.id;
  if (!userId) throw new ForbiddenException('Session required');
  return userId;
}

function requireSessionVersion(req: RequestWithAuth): number {
  const sessionVersion = req.user?.sessionVersion;
  if (typeof sessionVersion !== 'number') {
    throw new ForbiddenException('Session required');
  }
  return sessionVersion;
}
