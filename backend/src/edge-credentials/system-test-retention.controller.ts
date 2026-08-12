import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PurgeSystemTestRetentionRequestDto } from './dto/system-test-retention.dto.js';
import { UUID_V7_PATTERN } from './edge-credential.types.js';
import { SuperAdminEdgeGuard } from './super-admin-edge.guard.js';
import { SystemTestRetentionService } from './system-test-retention.service.js';

@Controller({ path: 'admin/system-test-retention', version: '1' })
@ApiCookieAuth()
@UseGuards(JwtAuthGuard, SuperAdminEdgeGuard)
export class SystemTestRetentionController {
  constructor(private readonly service: SystemTestRetentionService) {}

  @ApiOperation({
    summary: 'Purge eligible retained SYSTEM_TEST records',
    description:
      'Runs the facility-scoped atomic retention operation. Only resolved alerts whose capable validation grant is closed and whose server retention boundary has elapsed are removed. A durable non-private receipt is written only when rows are purged.',
  })
  @Post('purge')
  @HttpCode(200)
  purge(
    @Body() body: PurgeSystemTestRetentionRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    if (idempotencyKey === undefined || !UUID_V7_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException('Valid Idempotency-Key required');
    }
    return this.service.purge(body.facilityId, idempotencyKey);
  }
}
