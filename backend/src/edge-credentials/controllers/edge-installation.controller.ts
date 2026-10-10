import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  JwtAuthGuard,
  type RequestWithAuth,
} from '../../auth/guards/jwt-auth.guard.js';
import { EdgeAdminService } from '../services/edge-admin.service.js';
import {
  OwnershipTransferRequestDto,
  ReplaceEdgeInstallationRequestDto,
} from '../dto/edge-credential-request.dto.js';
import { mutationContext } from './edge-credential.controller.js';
import { EdgeCredentialService } from '../services/edge-credential.service.js';
import { SuperAdminEdgeGuard } from '../guards/super-admin-edge.guard.js';

@Controller({ path: 'admin/edge-installations', version: '1' })
@UseGuards(JwtAuthGuard, SuperAdminEdgeGuard)
export class EdgeInstallationAdminController {
  constructor(
    private readonly credentials: EdgeCredentialService,
    private readonly admin: EdgeAdminService,
  ) {}

  @Post(':edgeInstallationId/replace')
  replace(
    @Param('edgeInstallationId') id: string,
    @Body() body: ReplaceEdgeInstallationRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithAuth,
  ) {
    return this.credentials.replace(id, body, mutationContext(request, key));
  }

  @Post(':edgeInstallationId/transfers')
  transfer(
    @Param('edgeInstallationId') id: string,
    @Body() body: OwnershipTransferRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithAuth,
  ) {
    return this.admin.transfer(id, body, mutationContext(request, key));
  }
}
