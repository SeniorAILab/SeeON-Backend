import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import { FacilityContextInterceptor } from '../../auth/facility-context.interceptor.js';
import {
  RequireFacilityGuard,
  JwtAuthGuard,
} from '../../auth/jwt-auth.guard.js';
import { RequireCapability, RolesGuard } from '../../auth/roles.guard.js';
import type { RequestWithAuth } from '../../auth/jwt-auth.guard.js';
import {
  CreateSpaceRequestDto,
  type SpaceTypeValue,
  UpdateSpaceRequestDto,
} from '../dto/space.dto.js';
import { SpacesService } from '../services/spaces.service.js';

@Controller({ path: 'spaces', version: '1' })
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, RequireFacilityGuard)
@UseInterceptors(FacilityContextInterceptor)
export class SpacesController {
  constructor(private readonly service: SpacesService) {}
  @Get() list(
    @Req() req: RequestWithAuth,
    @Query('floorId') floorId?: string,
    @Query('type') type?: SpaceTypeValue,
    @Query('isActive') isActive?: string,
  ) {
    return this.service.list(requireFacilityId(req), {
      floorId,
      type,
      isActive: parseOptionalBoolean(isActive),
    });
  }
  @Get(':spaceId') getOne(
    @Req() req: RequestWithAuth,
    @Param('spaceId') spaceId: string,
  ) {
    return this.service.getOne(requireFacilityId(req), spaceId);
  }
  @UseGuards(RolesGuard)
  @RequireCapability('facilityAdmin')
  @Post()
  create(@Req() req: RequestWithAuth, @Body() body: CreateSpaceRequestDto) {
    return this.service.create(requireFacilityId(req), body);
  }
  @UseGuards(RolesGuard)
  @RequireCapability('facilityAdmin')
  @Patch(':spaceId')
  update(
    @Req() req: RequestWithAuth,
    @Param('spaceId') spaceId: string,
    @Body() body: UpdateSpaceRequestDto,
  ) {
    return this.service.update(requireFacilityId(req), spaceId, body);
  }
  @UseGuards(RolesGuard)
  @RequireCapability('facilityAdmin')
  @Delete(':spaceId')
  remove(@Req() req: RequestWithAuth, @Param('spaceId') spaceId: string) {
    return this.service.remove(requireFacilityId(req), spaceId);
  }
}
function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}
function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === 'true';
}
