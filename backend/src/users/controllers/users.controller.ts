import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import {
  JwtAuthGuard,
  RequireFacilityGuard,
  type RequestWithAuth,
} from '../../auth/jwt-auth.guard.js';
import { RequireCapability, RolesGuard } from '../../auth/roles.guard.js';
import {
  CreateUserRequestDto,
  UpdateUserRoleRequestDto,
} from '../dto/user.dto.js';
import { UsersService } from '../services/users.service.js';

@Controller({ path: 'users', version: '1' })
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, RequireFacilityGuard, RolesGuard)
@RequireCapability('facilityAdmin')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @ApiOperation({
    summary: 'List users in the effective facility scope',
    description:
      'Returns id, name, email, and role only; password hashes are never exposed.',
  })
  @Get()
  list(@Req() req: RequestWithAuth) {
    return this.service.list(requiredFacilityId(req));
  }

  @ApiOperation({
    summary: 'Create an ADMIN or STAFF user in the caller facility',
    description:
      'Creates the user with an admin-issued initial password. SUPER_ADMIN cannot be assigned.',
  })
  @ApiBody({ type: CreateUserRequestDto })
  @Post()
  create(@Req() req: RequestWithAuth, @Body() body: CreateUserRequestDto) {
    return this.service.create({
      facilityId: requiredFacilityId(req),
      name: body.name,
      email: body.email,
      role: body.role,
      initialPassword: body.initialPassword,
    });
  }

  @ApiOperation({
    summary: 'Change a facility user between ADMIN and STAFF',
    description:
      'Role changes are facility-scoped and take effect immediately: an existing JWT session for that user is rejected with 401 on its next request (role/sessionVersion revalidation), and re-login issues a token with the new role.',
  })
  @ApiBody({ type: UpdateUserRoleRequestDto })
  @Patch(':id/role')
  updateRole(
    @Param('id') id: string,
    @Req() req: RequestWithAuth,
    @Body() body: UpdateUserRoleRequestDto,
  ) {
    return this.service.updateRole(id, requiredFacilityId(req), body.role);
  }
}

function requiredFacilityId(req: RequestWithAuth): string {
  const facilityId = req.effectiveFacilityId ?? req.user?.facilityId;
  if (!facilityId) throw new ForbiddenException('Facility context required');
  return facilityId;
}
