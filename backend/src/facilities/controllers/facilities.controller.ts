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
import type { UpdateFacilityDto } from '../dto/facility.dto.js';

@Controller('api/facilities')
@UseGuards(SessionGuard, RequireFacilityGuard)
export class FacilitiesController {
  constructor(private readonly service: FacilitiesService) {}

  @Get('current')
  current(@Req() req: RequestWithAuth) {
    return this.service.current(requireFacilityId(req));
  }

  @Patch('current')
  update(@Req() req: RequestWithAuth, @Body() body: UpdateFacilityDto) {
    return this.service.update(requireFacilityId(req), body);
  }
}

function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}
