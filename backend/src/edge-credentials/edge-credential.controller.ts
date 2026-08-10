import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard, type RequestWithAuth } from '../auth/jwt-auth.guard.js';
import {
  IssueEdgeCredentialRequestDto,
  RecoverEdgeSecretRequestDto,
  RevokeEdgeCredentialRequestDto,
  RotateEdgeCredentialRequestDto,
  VerifyEdgeEnrollmentRequestDto,
} from './dto/edge-credential.dto.js';
import {
  EdgeCredentialService,
  type MutationContext,
} from './edge-credential.service.js';
import {
  EDGE_CREDENTIAL_LIFECYCLES,
  type EdgeCredentialLifecycleName,
  UUID_V7_PATTERN,
} from './edge-credential.types.js';
import { SuperAdminEdgeGuard } from './super-admin-edge.guard.js';

@Controller({ path: 'admin/edge-credentials', version: '1' })
@UseGuards(JwtAuthGuard, SuperAdminEdgeGuard)
export class EdgeCredentialAdminController {
  constructor(private readonly service: EdgeCredentialService) {}

  @Post()
  issue(
    @Body() body: IssueEdgeCredentialRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithAuth,
  ) {
    return this.service.issue(body, mutationContext(request, key));
  }

  @Get()
  list(
    @Query('facilityId') facilityId?: string,
    @Query('lifecycle') lifecycle?: string,
  ) {
    const parsed = parseLifecycle(lifecycle);
    return this.service.list(facilityId, parsed);
  }

  @Post(':tokenId/rotate')
  rotate(
    @Param('tokenId') tokenId: string,
    @Body() body: RotateEdgeCredentialRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithAuth,
  ) {
    return this.service.rotate(tokenId, body, mutationContext(request, key));
  }

  @Post(':tokenId/revoke')
  @HttpCode(200)
  revoke(
    @Param('tokenId') tokenId: string,
    @Body() body: RevokeEdgeCredentialRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithAuth,
  ) {
    return this.service.revoke(tokenId, body, mutationContext(request, key));
  }
}

@Controller({ path: 'admin/edge-operations', version: '1' })
@UseGuards(JwtAuthGuard, SuperAdminEdgeGuard)
export class EdgeOperationAdminController {
  constructor(private readonly service: EdgeCredentialService) {}

  @Post(':operationId/recover-secret')
  recover(
    @Param('operationId') operationId: string,
    @Body() body: RecoverEdgeSecretRequestDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithAuth,
  ) {
    return this.service.recoverSecret(
      operationId,
      body,
      mutationContext(request, key),
    );
  }
}

@Controller({ path: 'edge/enrollments', version: '1' })
export class EdgeEnrollmentController {
  constructor(private readonly service: EdgeCredentialService) {}

  @Post('verify')
  @HttpCode(200)
  verify(
    @Body() body: VerifyEdgeEnrollmentRequestDto,
    @Req() request: Request,
  ) {
    return this.service.verify({
      fullToken: bearerToken(request.headers.authorization),
      sourceIp: sourceIp(request),
      facilityCode: body.facilityCode,
      clientInstallationRef: body.clientInstallationRef,
    });
  }
}

export function mutationContext(
  request: RequestWithAuth,
  key: string | undefined,
): MutationContext {
  if (key === undefined || !UUID_V7_PATTERN.test(key)) {
    throw new BadRequestException('Valid Idempotency-Key required');
  }
  if (request.user === undefined)
    throw new UnauthorizedException('Missing session');
  return { idempotencyKey: key, actorUserId: request.user.id };
}

function bearerToken(value: string | undefined): string {
  if (value === undefined) return '';
  const match = /^(\S+)\s+(\S+)$/.exec(value.trim());
  if (match === null) return '';
  const scheme = match[1];
  const token = match[2];
  if (!scheme || !token) return '';
  return scheme.toLowerCase() === 'bearer' ? token : '';
}

function parseLifecycle(
  lifecycle: string | undefined,
): EdgeCredentialLifecycleName | undefined {
  if (lifecycle === undefined) return undefined;
  const matched = EDGE_CREDENTIAL_LIFECYCLES.find((item) => item === lifecycle);
  if (matched === undefined) throw new BadRequestException('Unknown lifecycle');
  return matched;
}

function sourceIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0];
  return (
    first?.trim() || request.ip || request.socket.remoteAddress || 'unknown'
  );
}
