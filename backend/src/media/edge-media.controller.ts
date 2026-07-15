import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RequestWithAuth } from '../auth/jwt-auth.guard.js';
import { EdgeIngestTokenGuard } from '../events/edge-ingest-token.guard.js';
import {
  EdgeMediaCapabilityQueryDto,
  ReportUnavailableClipRequestDto,
} from './dto/edge-media.dto.js';
import {
  parseReadyClipUpload,
  validateEventRefs,
  validateUnavailableClipId,
} from './edge-media-parser.js';
import {
  CLIP_STORAGE_ERROR_CODES,
  ClipStorageError,
} from './clip-storage.types.js';
import { EventMediaService } from './event-media.service.js';
import {
  EVENT_MEDIA_ERROR_CODES,
  EventMediaError,
} from './event-media.types.js';

@Controller({ path: 'events', version: '1' })
@UseGuards(EdgeIngestTokenGuard)
export class EdgeMediaController {
  constructor(private readonly media: EventMediaService) {}

  @Get('capabilities')
  capability(@Query() query: EdgeMediaCapabilityQueryDto) {
    return this.media.capability(query.camera_id);
  }

  @Put('clips/:clipId')
  @HttpCode(200)
  async uploadReady(
    @Param('clipId') clipId: string,
    @Req() request: RequestWithAuth,
  ) {
    try {
      return await this.media.uploadReady(
        parseReadyClipUpload(clipId, request.headers, request),
      );
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Put('clips/:clipId/state')
  @HttpCode(200)
  async reportUnavailable(
    @Param('clipId') clipId: string,
    @Body() body: ReportUnavailableClipRequestDto,
  ) {
    try {
      validateUnavailableClipId(clipId);
      return await this.media.reportUnavailable({
        externalClipId: clipId,
        cameraId: body.camera_id,
        eventRefs: validateEventRefs(body.event_refs),
        stateVersion: body.state_version,
        reason: body.reason,
      });
    } catch (error) {
      throw toHttpError(error);
    }
  }
}

function toHttpError(error: unknown): Error {
  if (error instanceof EventMediaError) {
    switch (error.code) {
      case EVENT_MEDIA_ERROR_CODES.DISABLED:
        return new HttpException(error.message, HttpStatus.NOT_FOUND);
      case EVENT_MEDIA_ERROR_CODES.INVALID_INPUT:
        return new HttpException(error.message, HttpStatus.BAD_REQUEST);
      case EVENT_MEDIA_ERROR_CODES.EVENT_OWNERSHIP:
      case EVENT_MEDIA_ERROR_CODES.IMMUTABLE_CONFLICT:
      case EVENT_MEDIA_ERROR_CODES.INVALID_TRANSITION:
      case EVENT_MEDIA_ERROR_CODES.HOLD_ACTIVE:
      case EVENT_MEDIA_ERROR_CODES.DELETION_DISABLED:
        return new HttpException(error.message, HttpStatus.CONFLICT);
    }
  }
  if (error instanceof ClipStorageError) {
    switch (error.code) {
      case CLIP_STORAGE_ERROR_CODES.INVALID_INPUT:
        return new HttpException(error.message, HttpStatus.BAD_REQUEST);
      case CLIP_STORAGE_ERROR_CODES.SIZE_LIMIT_EXCEEDED:
        return new HttpException(error.message, HttpStatus.PAYLOAD_TOO_LARGE);
      case CLIP_STORAGE_ERROR_CODES.CHECKSUM_MISMATCH:
      case CLIP_STORAGE_ERROR_CODES.LENGTH_MISMATCH:
      case CLIP_STORAGE_ERROR_CODES.UNSUPPORTED_MEDIA:
        return new HttpException(
          error.message,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      case CLIP_STORAGE_ERROR_CODES.IMMUTABLE_CONFLICT:
        return new HttpException(error.message, HttpStatus.CONFLICT);
      case CLIP_STORAGE_ERROR_CODES.INSUFFICIENT_STORAGE:
        return new HttpException(error.message, 507);
      case CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE:
      case CLIP_STORAGE_ERROR_CODES.LOCK_TIMEOUT:
        return new HttpException(error.message, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
  if (error instanceof Error) return error;
  return new HttpException('event media upload failed', 500);
}
