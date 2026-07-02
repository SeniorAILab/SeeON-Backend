import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import type {
  CreateFloorRequestDto,
  UpdateFloorRequestDto,
} from '../dto/floor.dto.js';
import { FloorsService } from '../services/floors.service.js';

@Controller({ path: 'floors', version: '1' })
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, RequireFacilityGuard)
@UseInterceptors(FacilityContextInterceptor)
export class FloorsController {
  constructor(private readonly service: FloorsService) {}
  @Get() list(@Req() req: RequestWithAuth) {
    return this.service.list(requireFacilityId(req));
  }
  @UseGuards(RolesGuard)
  @RequireCapability('facilityAdmin')
  @Post()
  create(@Req() req: RequestWithAuth, @Body() body: CreateFloorRequestDto) {
    return this.service.create(requireFacilityId(req), body);
  }
  @UseGuards(RolesGuard)
  @RequireCapability('facilityAdmin')
  @Patch(':floorId')
  update(
    @Req() req: RequestWithAuth,
    @Param('floorId') floorId: string,
    @Body() body: UpdateFloorRequestDto,
  ) {
    return this.service.update(requireFacilityId(req), floorId, body);
  }
  @UseGuards(RolesGuard)
  @RequireCapability('facilityAdmin')
  @Delete(':floorId')
  @HttpCode(204)
  async remove(@Req() req: RequestWithAuth, @Param('floorId') floorId: string) {
    await this.service.remove(requireFacilityId(req), floorId);
  }
}
function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}
