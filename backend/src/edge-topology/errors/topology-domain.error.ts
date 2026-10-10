import { HttpException } from '@nestjs/common';

export const TOPOLOGY_ERROR_CODES = {
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  INVALID_TOPOLOGY: 'INVALID_TOPOLOGY',
  MISMATCH: 'FACILITY_BINDING_MISMATCH',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  CLIENT_REVISION: 'CLIENT_REVISION_OUT_OF_SEQUENCE',
  STALE_REVISION: 'STALE_SERVER_REVISION',
  STALE_GENERATION: 'STALE_ENROLLMENT_GENERATION',
  TOPOLOGY_CONFLICT: 'TOPOLOGY_CONFLICT',
  TRANSFER_CONFLICT: 'TOPOLOGY_TRANSFER_CONFLICT',
  CONFIRMATION_STALE: 'CONFIRMATION_STALE',
  CONFIRMATION_EXPIRED: 'CONFIRMATION_EXPIRED',
} as const;

export type TopologyErrorCode =
  (typeof TOPOLOGY_ERROR_CODES)[keyof typeof TOPOLOGY_ERROR_CODES];

export class TopologyDomainError extends Error {
  readonly name = 'TopologyDomainError';

  constructor(
    readonly status: number,
    readonly code: TopologyErrorCode,
  ) {
    super(code);
  }
}

export function topologyHttpError(
  status: number,
  code: TopologyErrorCode,
): HttpException {
  const message =
    status === 410
      ? 'The topology confirmation has expired.'
      : status === 400
        ? 'Request does not match edge provisioning v1.'
        : 'Request state does not match current topology state.';
  return new HttpException(
    {
      schemaVersion: 1,
      error: { code, message, retryable: false, requestId: 'edge-topology' },
    },
    status,
  );
}
