import { Injectable } from '@nestjs/common';
import type { PurgeSystemTestRetentionResponseDto } from './dto/system-test-retention.dto.js';
import { SystemTestRetentionRepository } from './system-test-retention.repository.js';

@Injectable()
export class SystemTestRetentionService {
  constructor(private readonly repository: SystemTestRetentionRepository) {}

  async purge(
    facilityId: string,
    jobId: string,
  ): Promise<PurgeSystemTestRetentionResponseDto> {
    const result = await this.repository.purge(facilityId, jobId);
    return { schemaVersion: 1, ...result };
  }
}
