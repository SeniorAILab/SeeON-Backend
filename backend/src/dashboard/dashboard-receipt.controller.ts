import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { FacilityContextInterceptor } from '../auth/facility-context.interceptor.js';
import { JwtAuthGuard, RequireFacilityGuard } from '../auth/jwt-auth.guard.js';
import type { RequestWithAuth } from '../auth/jwt-auth.guard.js';
import { DashboardReceiptService } from './dashboard-receipt.service.js';
import {
  DashboardDeliveryReceiptRequestDto,
  DashboardPresentationReceiptRequestDto,
} from './dto/dashboard-receipt.dto.js';

@Controller({ path: 'dashboard/receipts', version: '1' })
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, RequireFacilityGuard)
@UseInterceptors(FacilityContextInterceptor)
export class DashboardReceiptController {
  constructor(private readonly receipts: DashboardReceiptService) {}

  @ApiOperation({ summary: 'Record normalized dashboard feed delivery' })
  @Post('delivery')
  @HttpCode(201)
  recordDelivery(
    @Req() req: RequestWithAuth,
    @Body() body: DashboardDeliveryReceiptRequestDto,
  ) {
    return this.receipts.recordDelivery({
      facilityId: requireFacilityId(req),
      ...body,
    });
  }

  @ApiOperation({ summary: 'Record committed dashboard DOM presentation' })
  @Post('presentation')
  @HttpCode(201)
  recordPresentation(
    @Req() req: RequestWithAuth,
    @Body() body: DashboardPresentationReceiptRequestDto,
  ) {
    return this.receipts.recordPresentation({
      facilityId: requireFacilityId(req),
      ...body,
    });
  }
}

function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}
