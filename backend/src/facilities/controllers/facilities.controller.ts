import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import {
  RequireFacilityGuard,
  JwtAuthGuard,
} from '../../auth/jwt-auth.guard.js';
import type { RequestWithAuth } from '../../auth/jwt-auth.guard.js';
import { RequireCapability, RolesGuard } from '../../auth/roles.guard.js';
import { UpdateFacilityRequestDto } from '../dto/facility.dto.js';
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

  @ApiOperation({
    summary: 'Update a facility',
    description:
      'Updates name, address, and phone for the authenticated facility.',
  })
  @ApiBody({ type: UpdateFacilityRequestDto })
  @Patch(':id')
  @UseGuards(RequireFacilityGuard, RolesGuard)
  @RequireCapability('facilityAdmin')
  update(
    @Param('id') id: string,
    @Req() req: RequestWithAuth,
    @Body() body: UpdateFacilityRequestDto,
  ) {
    rejectUnsupportedFacilityUpdateKeys(body);
    const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
    if (!facilityId) throw new ForbiddenException('Facility context required');
    if (id !== facilityId)
      throw new ForbiddenException('Facility scope mismatch');
    return this.service.update(id, body);
  }
}
function rejectUnsupportedFacilityUpdateKeys(body: UpdateFacilityRequestDto) {
  const allowedKeys = new Set(['name', 'address', 'phone']);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new BadRequestException({
        error: 'bad_request',
        message: 'Only name, address, and phone may be updated',
      });
    }
  }
}
