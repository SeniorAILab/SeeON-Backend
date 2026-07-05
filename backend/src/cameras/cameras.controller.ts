import {
  Body,
  ForbiddenException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { RequireFacilityGuard, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RequireCapability, RolesGuard } from '../auth/roles.guard.js';
import { FacilityContextInterceptor } from '../auth/facility-context.interceptor.js';
import type { RequestWithAuth } from '../auth/jwt-auth.guard.js';
import { CamerasService } from './cameras.service.js';
import type {
  CreateCameraRequestDto,
  UpdateCameraRequestDto,
} from './dto/camera.dto.js';

@Controller({ path: 'cameras', version: '1' })
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, RequireFacilityGuard)
@UseInterceptors(FacilityContextInterceptor)
export class CamerasController {
  constructor(private readonly service: CamerasService) {}

  @ApiOperation({
    summary: 'List cameras',
    description: 'Returns cameras configured for the authenticated facility.',
  })
  @Get()
  list(@Req() req: RequestWithAuth) {
    return this.service.list(requireFacilityId(req));
  }

  @ApiOperation({
    summary: 'Get one camera',
    description: 'Returns one camera in the authenticated facility by id.',
  })
  @Get(':id')
  getOne(@Req() req: RequestWithAuth, @Param('id') id: string) {
    return this.service.getOne(requireFacilityId(req), id);
  }

  @ApiOperation({
    summary: 'Create a camera',
    description:
      'Registers a camera label and room binding for the authenticated facility.',
  })
  @UseGuards(RolesGuard)
  @RequireCapability('facilityAdmin')
  @Post()
  create(@Req() req: RequestWithAuth, @Body() body: CreateCameraRequestDto) {
    return this.service.create(requireFacilityId(req), {
      label: body.label,
      spaceId: body.spaceId,
      rtspUrl: body.rtspUrl,
    });
  }

  @ApiOperation({
    summary: 'Update a camera',
    description:
      'Updates mutable camera metadata and room assignment inside the authenticated facility.',
  })
  @UseGuards(RolesGuard)
  @RequireCapability('facilityAdmin')
  @Patch(':id')
  update(
    @Req() req: RequestWithAuth,
    @Param('id') id: string,
    @Body() body: UpdateCameraRequestDto,
  ) {
    return this.service.update(requireFacilityId(req), id, body);
  }

  @ApiOperation({
    summary: 'Delete a camera',
    description: 'Removes a camera from the authenticated facility.',
  })
  @UseGuards(RolesGuard)
  @RequireCapability('facilityAdmin')
  @Delete(':id')
  remove(@Req() req: RequestWithAuth, @Param('id') id: string) {
    return this.service.remove(requireFacilityId(req), id);
  }
}

function requireFacilityId(req: RequestWithAuth): string {
  const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}
