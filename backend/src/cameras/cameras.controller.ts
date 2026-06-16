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
import { RequireOrgGuard, SessionGuard } from '../auth/session.guard.js';
import { OrgContextInterceptor } from '../auth/org-context.interceptor.js';
import type { RequestWithAuth } from '../auth/session.guard.js';
import { CamerasService } from './cameras.service.js';

@Controller('api/cameras')
@UseGuards(SessionGuard, RequireOrgGuard)
@UseInterceptors(OrgContextInterceptor)
export class CamerasController {
  constructor(private readonly service: CamerasService) {}

  @Get()
  list(@Req() req: RequestWithAuth) {
    return this.service.list(requireOrgId(req));
  }

  @Get(':id')
  getOne(@Req() req: RequestWithAuth, @Param('id') id: string) {
    return this.service.getOne(requireOrgId(req), id);
  }

  @Post()
  create(
    @Req() req: RequestWithAuth,
    @Body() body: { label?: string; residentId?: string },
  ) {
    return this.service.create(requireOrgId(req), {
      label: body.label ?? '',
      residentId: body.residentId,
    });
  }

  @Patch(':id')
  update(
    @Req() req: RequestWithAuth,
    @Param('id') id: string,
    @Body() body: { label?: string; residentId?: string },
  ) {
    return this.service.update(requireOrgId(req), id, body);
  }

  @Delete(':id')
  remove(@Req() req: RequestWithAuth, @Param('id') id: string) {
    return this.service.remove(requireOrgId(req), id);
  }
}

function requireOrgId(req: RequestWithAuth): string {
  const orgId = req.user?.orgId;
  if (!orgId) throw new ForbiddenException('Organization context required');
  return orgId;
}
