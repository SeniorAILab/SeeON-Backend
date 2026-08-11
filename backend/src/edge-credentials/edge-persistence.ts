import type { Prisma } from '@prisma/client';
import { EdgeOperationStatus } from '@prisma/client';
import type {
  GeneratedCredential,
  MutationIdentity,
  StoredOperationResult,
} from './edge-credential.types.js';

export function credentialCreateData(input: {
  readonly credential: GeneratedCredential;
  readonly facilityId: string;
  readonly edgeInstallationId: string;
  readonly enrollmentGeneration: number;
  readonly issuedAt: Date;
}): Prisma.EdgeCredentialUncheckedCreateInput {
  return {
    tokenId: input.credential.tokenId,
    tokenDigest: input.credential.digest,
    tokenPrefix: input.credential.prefix,
    facilityId: input.facilityId,
    edgeInstallationId: input.edgeInstallationId,
    enrollmentGeneration: input.enrollmentGeneration,
    issuedAt: input.issuedAt,
  };
}

export async function persistOperation(input: {
  readonly tx: Prisma.TransactionClient;
  readonly facilityId: string;
  readonly operationType: string;
  readonly identity: MutationIdentity;
  readonly result: StoredOperationResult;
  readonly completedAt: Date;
}): Promise<void> {
  await input.tx.edgeAdminOperation.create({
    data: {
      id: input.identity.operationId,
      facilityId: input.facilityId,
      idempotencyKey: input.identity.idempotencyKey,
      operationType: input.operationType,
      bodyHash: input.identity.bodyHash,
      status: EdgeOperationStatus.SUCCEEDED,
      redactedResult: input.result,
      completedAt: input.completedAt,
    },
  });
}

export async function persistAudit(input: {
  readonly tx: Prisma.TransactionClient;
  readonly facilityId: string;
  readonly edgeInstallationId: string | null;
  readonly enrollmentGeneration: number | null;
  readonly identity: MutationIdentity;
  readonly action: string;
  readonly occurredAt: Date;
}): Promise<void> {
  await input.tx.edgeProvisioningAudit.create({
    data: {
      facilityId: input.facilityId,
      edgeInstallationId: input.edgeInstallationId,
      enrollmentGeneration: input.enrollmentGeneration,
      actorUserId: input.identity.actorUserId,
      action: input.action,
      outcome: 'SUCCEEDED',
      requestId: input.identity.idempotencyKey,
      operationId: input.identity.operationId,
      occurredAt: input.occurredAt,
    },
  });
}
