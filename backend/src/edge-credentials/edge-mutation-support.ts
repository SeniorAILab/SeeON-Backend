import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { generateFacilityCode, uuidV7 } from './edge-credential-crypto.js';
import { EdgeCredentialQueryRepository } from './edge-credential-query.repository.js';
import type { MutationIdentity } from './edge-credential.types.js';
import { EDGE_ERROR_CODES, edgeHttpError } from './edge-errors.js';

export type MutationContext = {
  readonly idempotencyKey: string;
  readonly actorUserId: string;
};

@Injectable()
export class EdgeMutationSupport {
  constructor(
    private readonly config: ConfigService,
    private readonly queries: EdgeCredentialQueryRepository,
  ) {}

  identity(
    context: MutationContext,
    hash: string,
    now: Date,
  ): MutationIdentity {
    return {
      operationId: uuidV7(now.getTime()),
      idempotencyKey: context.idempotencyKey,
      bodyHash: hash,
      actorUserId: context.actorUserId,
    };
  }

  async replay(
    idempotencyKey: string,
    operationType: string,
    hash: string,
  ): Promise<Prisma.JsonValue | null> {
    const existing = await this.queries.findOperation(idempotencyKey);
    if (existing === null) return null;
    if (
      existing.operationType !== operationType ||
      existing.bodyHash !== hash
    ) {
      throw edgeHttpError(409, EDGE_ERROR_CODES.IDEMPOTENCY_CONFLICT);
    }
    return existing.redactedResult;
  }

  async uniqueFacilityCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateFacilityCode();
      if (!(await this.queries.facilityCodeExists(candidate))) return candidate;
    }
    throw edgeHttpError(503, EDGE_ERROR_CODES.NOT_CONFIGURED, true);
  }

  pepper(): string {
    const value = this.config.get<string>('EDGE_TOKEN_PEPPER')?.trim();
    if (!value) throw edgeHttpError(503, EDGE_ERROR_CODES.NOT_CONFIGURED, true);
    return value;
  }
}
