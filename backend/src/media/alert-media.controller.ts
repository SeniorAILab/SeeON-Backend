import {
  Body,
  Controller,
  Get,
  Head,
  Header,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { JwtAuthGuard, type RequestWithAuth } from '../auth/jwt-auth.guard.js';
import { RequireCapability, RolesGuard } from '../auth/roles.guard.js';
import { AlertMediaExceptionFilter } from './alert-media-exception.filter.js';
import { AlertMediaFacilityGuard } from './alert-media-facility.guard.js';
import { AlertMediaAccessRequestDto } from './dto/alert-media-access.dto.js';
import { selectByteRange, type ByteSelection } from './alert-media-range.js';
import {
  AlertMediaService,
  type OpenedAlertMedia,
} from './alert-media.service.js';

const CACHE_CONTROL = 'private, no-store, no-transform';

@Controller({ path: 'alerts', version: '1' })
@ApiCookieAuth()
@UseFilters(AlertMediaExceptionFilter)
@UseGuards(JwtAuthGuard, RolesGuard, AlertMediaFacilityGuard)
@RequireCapability('facilityAdmin')
export class AlertMediaController {
  constructor(private readonly service: AlertMediaService) {}

  @Get(':alertId/media')
  @Header('Cache-Control', CACHE_CONTROL)
  metadata(@Req() request: RequestWithAuth, @Param('alertId') alertId: string) {
    return this.service.metadata(requireFacilityId(request), alertId);
  }

  @Post(':alertId/media/access')
  @Header('Cache-Control', CACHE_CONTROL)
  recordAccess(
    @Req() request: RequestWithAuth,
    @Param('alertId') alertId: string,
    @Body() body: AlertMediaAccessRequestDto,
  ) {
    const actor = requireActor(request);
    return this.service.recordAccess({
      facilityId: requireFacilityId(request),
      alertId,
      actorUserId: actor.id,
      actorRole: actor.role,
      action: body.action,
      interactionId: body.interactionId,
    });
  }

  @Head(':alertId/media/content')
  async headContent(
    @Req() request: RequestWithAuth,
    @Param('alertId') alertId: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.respondContent(request, response, alertId, true);
  }

  @Get(':alertId/media/content')
  async getContent(
    @Req() request: RequestWithAuth,
    @Param('alertId') alertId: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.respondContent(request, response, alertId, false);
  }

  private async respondContent(
    request: RequestWithAuth,
    response: Response,
    alertId: string,
    headOnly: boolean,
  ): Promise<void> {
    const media = await this.service.openContent(
      requireFacilityId(request),
      alertId,
    );
    try {
      const etag = `"sha256-${media.sha256}"`;
      const selection = selectByteRange(
        request.headers.range,
        request.headers['if-range'],
        { sizeBytes: media.sizeBytes, etag, lastModified: media.readyAt },
      );
      setCommonHeaders(response, media, etag);
      if (selection.kind === 'unsatisfiable') {
        response.status(416);
        response.setHeader('content-range', `bytes */${media.sizeBytes}`);
        response.setHeader('content-length', '0');
        response.end();
        return;
      }
      setSelectedHeaders(response, selection, media.sizeBytes);
      if (headOnly) {
        response.end();
        return;
      }
      const stream = media.handle.createReadStream({
        start: selection.start,
        end: selection.end,
        autoClose: false,
      });
      await pipeline(stream, response);
    } finally {
      await media.handle.close();
    }
  }
}

function setCommonHeaders(
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
  response.setHeader('content-disposition', 'inline');
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
