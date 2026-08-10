import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, type RequestWithAuth } from '../auth/jwt-auth.guard.js';
import { EdgeAdminService } from './edge-admin.service.js';
import {
  CreateValidationRunRequestDto,
  OwnershipTransferRequestDto,
  ReplaceEdgeInstallationRequestDto,
} from './dto/edge-credential.dto.js';
import { mutationContext } from './edge-credential.controller.js';
import { EdgeCredentialService } from './edge-credential.service.js';
import { SuperAdminEdgeGuard } from './super-admin-edge.guard.js';

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

  @Post(':edgeInstallationId/validation-runs')
  validationRun(
    @Param('edgeInstallationId') id: string,
    @Body() body: CreateValidationRunRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithAuth,
  ) {
    return this.admin.createValidationRun(
      id,
      body,
      mutationContext(request, key),
    );
  }

  @Get(':edgeInstallationId/validation-runs/:validationRunId/events')
  validationEvents(
    @Param('edgeInstallationId') id: string,
    @Param('validationRunId') runId: string,
  ) {
    return this.admin.validationEvents(id, runId);
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
