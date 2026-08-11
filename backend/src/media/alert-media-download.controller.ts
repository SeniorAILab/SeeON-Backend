import {
  Controller,
  Get,
  Head,
  Param,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { JwtAuthGuard, type RequestWithAuth } from '../auth/jwt-auth.guard.js';
import { RequireCapability, RolesGuard } from '../auth/roles.guard.js';
import { AlertMediaExceptionFilter } from './alert-media-exception.filter.js';
import { AlertMediaFacilityGuard } from './alert-media-facility.guard.js';
import { selectByteRange, type ByteSelection } from './alert-media-range.js';
import {
  AlertMediaService,
  type OpenedAlertMedia,
} from './alert-media.service.js';
import { MediaDownloadAuditService } from './media-download-audit.service.js';

const CACHE_CONTROL = 'private, no-store, no-transform';
const ATTACHMENT = 'attachment; filename="incident-clip.mp4"';

@Controller({ path: 'alerts', version: '1' })
@ApiCookieAuth()
@UseFilters(AlertMediaExceptionFilter)
@UseGuards(JwtAuthGuard, RolesGuard, AlertMediaFacilityGuard)
@RequireCapability('facilityAdmin')
export class AlertMediaDownloadController {
  constructor(
    private readonly media: AlertMediaService,
    private readonly audits: MediaDownloadAuditService,
  ) {}

  @Head(':alertId/media/download')
  async headDownload(
    @Req() request: RequestWithAuth,
    @Param('alertId') alertId: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.respond(request, response, alertId, true);
  }

  @Get(':alertId/media/download')
  async getDownload(
    @Req() request: RequestWithAuth,
    @Param('alertId') alertId: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.respond(request, response, alertId, false);
  }

  private async respond(
    request: RequestWithAuth,
    response: Response,
    alertId: string,
    headOnly: boolean,
  ): Promise<void> {
    const facilityId = requireFacilityId(request);
    const opened = await this.media.openContent(facilityId, alertId);
    try {
      const etag = `"sha256-${opened.sha256}"`;
      setDownloadHeaders(response, opened, etag);
      if (isNotModified(request.headers['if-none-match'], etag)) {
        response.status(304).end();
        return;
      }
      const selection = selectByteRange(
        request.headers.range,
        request.headers['if-range'],
        { sizeBytes: opened.sizeBytes, etag, lastModified: opened.readyAt },
      );
      if (selection.kind === 'unsatisfiable') {
        response.status(416);
        response.setHeader('content-range', `bytes */${opened.sizeBytes}`);
        response.setHeader('content-length', '0');
        response.end();
        return;
      }
      setSelectedHeaders(response, selection, opened.sizeBytes);
      if (headOnly) {
        response.end();
        return;
      }
      await this.stream(
        request,
        response,
        alertId,
        facilityId,
        opened,
        selection,
      );
    } finally {
      await opened.handle.close();
    }
  }

  private async stream(
    request: RequestWithAuth,
    response: Response,
    alertId: string,
    facilityId: string,
    opened: OpenedAlertMedia,
    selection: Exclude<ByteSelection, { readonly kind: 'unsatisfiable' }>,
  ): Promise<void> {
    const actor = requireActor(request);
    const bytesPlanned = selection.end - selection.start + 1;
    const transfer = await this.audits.beginDownload({
      facilityId,
      clipId: opened.clipId,
      alertId,
      actorUserId: actor.id,
      actorRole: actor.role,
      requestId: correlationId(request.headers['x-request-id']),
      httpStatus: selection.kind === 'range' ? 206 : 200,
      rangeStart: selection.kind === 'range' ? selection.start : null,
      rangeEnd: selection.kind === 'range' ? selection.end : null,
      bytesPlanned,
    });
    let bytesActual = 0;
    let settlement: Promise<boolean> | null = null;
    const settleCompleted = (): void => {
      settlement ??= transfer.complete(bytesActual);
    };
    const settleAborted = (): void => {
      settlement ??= transfer.abort(bytesActual, 'RESPONSE_CLOSED');
    };
    response.once('finish', settleCompleted);
    response.once('close', () => {
      if (!response.writableFinished) settleAborted();
    });
    response.once('error', settleAborted);
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesActual += chunk.length;
        callback(null, chunk);
      },
    });
    const stream = opened.handle.createReadStream({
      start: selection.start,
      end: selection.end,
      autoClose: false,
    });
    try {
      await pipeline(stream, counter, response);
      settleCompleted();
    } catch (error) {
      settleAborted();
      if (!response.headersSent) throw error;
    } finally {
      response.removeListener('finish', settleCompleted);
      response.removeListener('error', settleAborted);
      settlement ??= transfer.abort(bytesActual, 'STREAM_TERMINATED');
      await this.audits.observeSettlement(settlement);
    }
  }
}

function setDownloadHeaders(
  response: Response,
  media: OpenedAlertMedia,
  etag: string,
): void {
  response.setHeader('content-type', 'video/mp4');
  response.setHeader('accept-ranges', 'bytes');
  response.setHeader('cache-control', CACHE_CONTROL);
  response.setHeader('etag', etag);
  response.setHeader('last-modified', media.readyAt.toUTCString());
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('content-disposition', ATTACHMENT);
}

function setSelectedHeaders(
  response: Response,
  selection: Exclude<ByteSelection, { readonly kind: 'unsatisfiable' }>,
  sizeBytes: number,
): void {
  const selectedLength = selection.end - selection.start + 1;
  response.status(selection.kind === 'range' ? 206 : 200);
  response.setHeader('content-length', String(selectedLength));
  if (selection.kind === 'range') {
    response.setHeader(
      'content-range',
      `bytes ${selection.start}-${selection.end}/${sizeBytes}`,
    );
  }
}

function isNotModified(
  header: string | readonly string[] | undefined,
  etag: string,
): boolean {
  if (typeof header !== 'string') return false;
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value === etag || value === `W/${etag}`;
  });
}

function correlationId(header: string | readonly string[] | undefined): string {
  if (typeof header === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(header)) {
    return header;
  }
  return randomUUID();
}

function requireFacilityId(request: RequestWithAuth): string {
  const facilityId = request.effectiveFacilityId ?? request.user?.facilityId;
  if (facilityId === undefined || facilityId === null) {
    throw new UnauthorizedException('Missing facility scope');
  }
  return facilityId;
}

function requireActor(request: RequestWithAuth) {
  const user = request.user;
  if (user === undefined) throw new UnauthorizedException('Missing session');
  return { id: user.id, role: user.role };
}
