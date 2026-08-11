import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { EdgeFacilityTokenGuard } from '../cameras/edge-facility-token.guard.js';
import type {
  EdgeAuthenticatedRequest,
  EdgePrincipal,
} from '../edge-credentials/edge-credential.types.js';
import {
  EdgeTopologyConfirmationRequestDto,
  EdgeTopologySnapshotRequestDto,
} from './dto/edge-topology.dto.js';
import {
  TOPOLOGY_ERROR_CODES,
  topologyHttpError,
} from './edge-topology.errors.js';
import { EdgeTopologyService } from './edge-topology.service.js';

@Controller({ path: 'edge/topology-snapshots', version: '1' })
@UseGuards(EdgeFacilityTokenGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    exceptionFactory: () =>
      topologyHttpError(400, TOPOLOGY_ERROR_CODES.INVALID_SCHEMA),
  }),
)
export class EdgeTopologyController {
  constructor(private readonly service: EdgeTopologyService) {}

  @Put(':snapshotId')
  @HttpCode(200)
  apply(
    @Req() request: EdgeAuthenticatedRequest,
    @Param('snapshotId') snapshotId: string,
    @Body() body: EdgeTopologySnapshotRequestDto,
  ) {
    return this.service.apply(snapshotId, body, topologyPrincipal(request));
  }

  @Post(':snapshotId/confirm')
  @HttpCode(200)
  confirm(
    @Req() request: EdgeAuthenticatedRequest,
    @Param('snapshotId') snapshotId: string,
    @Body() body: EdgeTopologyConfirmationRequestDto,
  ) {
    return this.service.confirm(snapshotId, body, topologyPrincipal(request));
  }
}

function topologyPrincipal(request: EdgeAuthenticatedRequest): EdgePrincipal {
  if (
    request.edgePrincipal === undefined ||
    request.headers['x-facility-id'] !== undefined ||
    request.headers['facility-id'] !== undefined
  ) {
    throw topologyHttpError(403, TOPOLOGY_ERROR_CODES.MISMATCH);
  }
  return request.edgePrincipal;
}
