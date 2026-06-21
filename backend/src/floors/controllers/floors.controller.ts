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
import { FacilityContextInterceptor } from '../../auth/facility-context.interceptor.js';
import {
  RequireFacilityGuard,
  SessionGuard,
} from '../../auth/session.guard.js';
import type { RequestWithAuth } from '../../auth/session.guard.js';
import type { CreateFloorDto, UpdateFloorDto } from '../dto/floor.dto.js';
import { FloorsService } from '../services/floors.service.js';

@Controller('api/floors')
@UseGuards(SessionGuard, RequireFacilityGuard)
@UseInterceptors(FacilityContextInterceptor)
export class FloorsController {
  constructor(private readonly service: FloorsService) {}
  @Get() list(@Req() req: RequestWithAuth) {
    return this.service.list(requireFacilityId(req));
  }
  @Post() create(@Req() req: RequestWithAuth, @Body() body: CreateFloorDto) {
    return this.service.create(requireFacilityId(req), body);
  }
  @Patch(':floorId') update(
    @Req() req: RequestWithAuth,
    @Param('floorId') floorId: string,
    @Body() body: UpdateFloorDto,
  ) {
    return this.service.update(requireFacilityId(req), floorId, body);
  }
  @Delete(':floorId')
  @HttpCode(204)
  async remove(@Req() req: RequestWithAuth, @Param('floorId') floorId: string) {
    await this.service.remove(requireFacilityId(req), floorId);
  }
}
function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}
