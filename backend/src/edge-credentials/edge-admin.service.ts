import { Inject, Injectable } from '@nestjs/common';
import { EdgeTopologyEntityKind, Prisma } from '@prisma/client';
import {
  EdgeAdminRepository,
  type TransferItem,
} from './edge-admin.repository.js';
import { EDGE_CLOCK, type EdgeClock } from './edge-clock.js';
import { bodyHash, uuidV7 } from './edge-credential-crypto.js';
import { EdgeCredentialQueryRepository } from './edge-credential-query.repository.js';
import type { MutationContext } from './edge-credential.service.js';
import type { MutationIdentity } from './edge-credential.types.js';
import { EDGE_ERROR_CODES, edgeHttpError } from './edge-errors.js';

@Injectable()
export class EdgeAdminService {
  constructor(
    private readonly repository: EdgeAdminRepository,
    private readonly queries: EdgeCredentialQueryRepository,
    @Inject(EDGE_CLOCK) private readonly clock: EdgeClock,
  ) {}

  async createValidationRun(
    edgeInstallationId: string,
    body: {
      readonly schemaVersion: 1;
      readonly expectedEnrollmentGeneration: number;
      readonly durationSeconds: number;
    },
    context: MutationContext,
  ) {
    const hash = bodyHash({ edgeInstallationId, ...body });
    const replay = await this.replay(
      context.idempotencyKey,
      'VALIDATION_RUN',
      hash,
    );
    if (replay !== null) return replay;
    const now = this.clock.now();
    const result = await this.repository.createValidationGrant({
      edgeInstallationId,
      expectedGeneration: body.expectedEnrollmentGeneration,
      validationRunId: uuidV7(now.getTime()),
      expiresAt: new Date(now.getTime() + body.durationSeconds * 1000),
      now,
      identity: identity(context, hash, now),
    });
    if (result === null) {
      throw edgeHttpError(409, EDGE_ERROR_CODES.STALE_GENERATION);
    }
    return result;
  }

  async validationEvents(edgeInstallationId: string, validationRunId: string) {
    const events = await this.repository.validationEvents(
      edgeInstallationId,
      validationRunId,
    );
    if (events === null) throw edgeHttpError(403, EDGE_ERROR_CODES.MISMATCH);
    return { schemaVersion: 1, items: events };
  }

  async transfer(
    edgeInstallationId: string,
    body: {
      readonly schemaVersion: 1;
      readonly expectedEnrollmentGeneration: number;
      readonly expectedServerRevision: number;
      readonly manifestDigest: string;
      readonly manifest: readonly {
        readonly kind: 'FLOOR' | 'ROOM' | 'CAMERA';
        readonly edgeRef: string;
        readonly canonicalId: string;
        readonly parentCanonicalId: string | null;
      }[];
    },
    context: MutationContext,
  ) {
    const hash = bodyHash({ edgeInstallationId, ...body });
    const replay = await this.replay(
      context.idempotencyKey,
      'OWNERSHIP_TRANSFER',
      hash,
    );
    if (replay !== null) return replay;
    if (bodyHash(body.manifest) !== body.manifestDigest) {
      throw edgeHttpError(409, EDGE_ERROR_CODES.TRANSFER_CONFLICT);
    }
    const now = this.clock.now();
    const result = await this.repository.applyTransfer({
      edgeInstallationId,
      generation: body.expectedEnrollmentGeneration,
      expectedServerRevision: body.expectedServerRevision,
      manifestDigest: body.manifestDigest,
      manifest: body.manifest.map(toTransferItem),
      now,
      identity: identity(context, hash, now),
    });
    if (result === null) {
      throw edgeHttpError(409, EDGE_ERROR_CODES.TRANSFER_CONFLICT);
    }
    return result;
  }

  private async replay(
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
}

function identity(
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

function toTransferItem(item: {
  readonly kind: 'FLOOR' | 'ROOM' | 'CAMERA';
  readonly edgeRef: string;
  readonly canonicalId: string;
  readonly parentCanonicalId: string | null;
}): TransferItem {
  return {
    ...item,
    kind: EdgeTopologyEntityKind[item.kind],
  };
}
