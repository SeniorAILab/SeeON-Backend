import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import {
  RequireFacilityGuard,
  JwtAuthGuard,
} from '../../auth/jwt-auth.guard.js';
import type { RequestWithAuth } from '../../auth/jwt-auth.guard.js';
import { FacilitiesService } from '../services/facilities.service.js';

@Controller({ path: 'facilities', version: '1' })
@ApiCookieAuth()
@UseGuards(JwtAuthGuard)
export class FacilitiesController {
  constructor(private readonly service: FacilitiesService) {}

  @ApiOperation({
    summary: 'List facilities available to the user',
    description: `Returns every facility for super admins or the user's own facility for facility-scoped users.`,
  })
  @Get()
  list(@Req() req: RequestWithAuth) {
    if (!req.user) throw new ForbiddenException('Session user required');
    return this.service.listForUser(req.user);
  }

  @ApiOperation({
    summary: 'Get a facility by id',
    description:
      'Returns the requested facility only when it matches the caller facility scope.',
  })
  @Get(':id')
  @UseGuards(RequireFacilityGuard)
  get(@Param('id') id: string, @Req() req: RequestWithAuth) {
    const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
    if (!facilityId) throw new ForbiddenException('Facility context required');
    return this.service.getScoped(id, facilityId);
  }
}
