import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { FacilityContextInterceptor } from '../auth/facility-context.interceptor.js';
import { JwtAuthGuard, RequireFacilityGuard } from '../auth/jwt-auth.guard.js';
import { EdgeIngestTokenGuard } from '../events/edge-ingest-token.guard.js';
import type { RequestWithAuth } from '../auth/jwt-auth.guard.js';
import {
  type MlConfigResponseDto,
  UpdateNightWindowRequestDto,
} from './dto/ml-config.dto.js';
import { MlConfigService } from './ml-config.service.js';

@Controller({ path: 'ml-config', version: '1' })
export class MlConfigController {
  constructor(private readonly service: MlConfigService) {}

  @ApiOperation({
    summary:
      'Read ML runtime config for an edge worker (shared edge bearer token; RTSP-bearing payload)',
  })
  @ApiBearerAuth()
  @UseGuards(EdgeIngestTokenGuard)
  @Get(':facilityId')
  getConfig(
    @Param('facilityId') facilityId: string,
  ): Promise<MlConfigResponseDto> {
    return this.service.getConfig(facilityId);
  }

  @ApiOperation({ summary: 'Update facility ML night-window policy' })
  @Put(':facilityId/night-window')
  @HttpCode(200)
  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard, RequireFacilityGuard)
  @UseInterceptors(FacilityContextInterceptor)
  updateNightWindow(
    @Req() req: RequestWithAuth,
    @Param('facilityId') facilityId: string,
    @Body() body: UpdateNightWindowRequestDto,
  ): Promise<MlConfigResponseDto> {
    const authenticatedFacilityId = requireFacilityId(req);
    if (facilityId !== authenticatedFacilityId) {
      throw new ForbiddenException('Facility mismatch');
    }
    return this.service.updateNightWindow(facilityId, body);
  }
}

function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}
