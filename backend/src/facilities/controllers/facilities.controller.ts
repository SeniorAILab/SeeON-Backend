import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  RequireFacilityGuard,
  SessionGuard,
} from '../../auth/session.guard.js';
import type { RequestWithAuth } from '../../auth/session.guard.js';
import { FacilitiesService } from '../services/facilities.service.js';
import type { UpdateFacilityRequestDto } from '../dto/facility.dto.js';

@Controller({ path: 'facilities', version: '1' })
@UseGuards(SessionGuard)
export class FacilitiesController {
  constructor(private readonly service: FacilitiesService) {}

  @Get()
  list(@Req() req: RequestWithAuth) {
    if (!req.user) throw new ForbiddenException('Session user required');
    return this.service.listForUser(req.user);
  }

  @Get('current')
  @UseGuards(RequireFacilityGuard)
  current(@Req() req: RequestWithAuth) {
    return this.service.current(requireFacilityId(req));
  }

  @Patch('current')
  @UseGuards(RequireFacilityGuard)
  update(@Req() req: RequestWithAuth, @Body() body: UpdateFacilityRequestDto) {
    return this.service.update(requireFacilityId(req), body);
  }
}

function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}
