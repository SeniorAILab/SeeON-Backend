import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { parseAlertStatus } from './dto/alert-status.dto.js';
import { RequireFacilityGuard, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { FacilityContextInterceptor } from '../auth/facility-context.interceptor.js';
import type { RequestWithAuth } from '../auth/jwt-auth.guard.js';
import { AlertsService } from './alerts.service.js';
import { CreateAlertNoteRequestDto } from './dto/alert-note.dto.js';
import { FacilityScopedNotFoundException } from '../common/domain-errors.js';
import {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_EXTENSIONS,
  readRequestBody,
  resolveSnapshotPath,
  snapshotRoot,
} from '../common/snapshot-storage.js';

@Controller({ path: 'alerts', version: '1' })
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, RequireFacilityGuard)
@UseInterceptors(FacilityContextInterceptor)
export class AlertsController {
  constructor(private readonly service: AlertsService) {}

  @ApiOperation({
    summary: 'List alerts',
    description:
      'Returns facility-scoped alerts with optional status, sequence, and limit filters for dashboard history and reconciliation.',
  })
  @Get()
  list(
    @Req() req: RequestWithAuth,
    @Query('status') status?: string,
    @Query('afterSeq') afterSeq?: string,
    @Query('beforeSeq') beforeSeq?: string,
    @Query('limit') limit?: string,
  ) {
    const validStatus = parseAlertStatus(status);
    return this.service.list(requireFacilityId(req), {
      status: validStatus,
      afterSeq: afterSeq ? BigInt(afterSeq) : undefined,
      beforeSeq: beforeSeq ? BigInt(beforeSeq) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @ApiOperation({
    summary: 'Get one alert',
    description: `Returns a single facility-scoped alert by id or 404 when it is outside the caller's facility.`,
  })
  @Get(':id')
  getOne(@Req() req: RequestWithAuth, @Param('id') id: string) {
    return this.service.getOne(requireFacilityId(req), id);
  }

  @ApiOperation({
    summary: 'Add an alert note',
    description:
      'Appends a facility-scoped action note to an alert with the current user and role snapshotted.',
  })
  @Post(':id/notes')
  @HttpCode(201)
  addNote(
    @Req() req: RequestWithAuth,
    @Param('id') id: string,
    @Body() body: CreateAlertNoteRequestDto,
  ) {
    return this.service.addNote({
      facilityId: requireFacilityId(req),
      alertId: id,
      note: body.note,
      actorUserId: requireUserId(req),
      actorRole: requireAuthorRole(req),
    });
  }

  @ApiOperation({
    summary: 'Resolve an alert',
    description:
      'Marks an alert resolved by the current user and emits the live alert-updated dashboard frame.',
  })
  @Patch(':id/resolve')
  @HttpCode(200)
  resolve(@Req() req: RequestWithAuth, @Param('id') id: string) {
    return this.service.resolve(requireFacilityId(req), id, requireUserId(req));
  }

  /**
   * PUT /api/alerts/:alertId/snapshot — authenticated snapshot upload.
   * Stores bytes locally under a server-derived key; payload URLs are never fetched.
   */
  @ApiOperation({
    summary: 'Upload an alert snapshot',
    description:
      'Stores a bounded authenticated snapshot upload under a server-owned key without fetching remote URLs.',
  })
  @Put(':alertId/snapshot')
  @HttpCode(201)
  async uploadSnapshot(
    @Req() req: RequestWithAuth,
    @Param('alertId') alertId: string,
  ) {
    const facilityId = requireFacilityId(req);
    const alert = await this.service.getOne(facilityId, alertId);
    const contentType = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const extension = SNAPSHOT_EXTENSIONS.get(contentType);
    if (!extension) {
      throw new BadRequestException('Unsupported snapshot content type');
    }

    const body = await readRequestBody(req, MAX_SNAPSHOT_BYTES);
    if (body.length === 0) throw new BadRequestException('Snapshot is empty');

    const snapshotDir = snapshotRoot();
    const snapshotKey = path.posix.join(facilityId, `${alert.id}.${extension}`);
    const filePath = resolveSnapshotPath(snapshotDir, snapshotKey);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, body);
    await this.service.setSnapshotKey(facilityId, alert.id, snapshotKey);

    return { snapshotKey };
  }

  /**
   * GET /api/alerts/:alertId/snapshot — Snapshot proxy (F5).
   * Verifies alert.facilityId == req.user.facilityId, then streams file from local disk.
   * Backend never dereferences edge URLs (SSRF-safe).
   */
  @ApiOperation({
    summary: 'Download an alert snapshot',
    description:
      'Streams a stored facility-scoped alert snapshot from local storage after validating alert ownership.',
  })
  @Get(':alertId/snapshot')
  async snapshot(
    @Req() req: RequestWithAuth,
    @Param('alertId') alertId: string,
    @Res() res: Response,
  ) {
    const alert = await this.service.getOne(requireFacilityId(req), alertId);
    if (!alert.snapshotKey)
      throw new FacilityScopedNotFoundException('snapshot');

    // snapshotKey is a relative server-owned key under SNAPSHOT_DIR.
    const snapshotDir = snapshotRoot();
    const filePath = resolveSnapshotPath(snapshotDir, alert.snapshotKey);

    if (!fs.existsSync(filePath))
      throw new FacilityScopedNotFoundException('snapshot');

    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('cache-control', 'private, max-age=300');
    fs.createReadStream(filePath).pipe(res);
  }
}

function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}

function requireUserId(req: RequestWithAuth): string {
  const userId = req.user?.id;
  if (!userId) throw new ForbiddenException('Session user required');
  return userId;
}

function requireAuthorRole(req: RequestWithAuth): 'ADMIN' | 'STAFF' {
  const role = req.user?.role;
  if (role !== 'ADMIN' && role !== 'STAFF') {
    throw new ForbiddenException(
      'Alert notes require an ADMIN or STAFF session',
    );
  }
  return role;
}
