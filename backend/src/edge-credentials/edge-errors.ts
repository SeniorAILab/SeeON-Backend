import { HttpException } from '@nestjs/common';

export const EDGE_ERROR_CODES = {
  REQUIRED: 'EDGE_CREDENTIAL_REQUIRED',
  INVALID: 'EDGE_CREDENTIAL_INVALID',
  INACTIVE: 'EDGE_CREDENTIAL_INACTIVE',
  MISMATCH: 'FACILITY_BINDING_MISMATCH',
  INSTALLATION_CONFLICT: 'INSTALLATION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  STALE_GENERATION: 'STALE_ENROLLMENT_GENERATION',
  TRANSFER_CONFLICT: 'TOPOLOGY_TRANSFER_CONFLICT',
  RATE_LIMITED: 'ENROLLMENT_RATE_LIMITED',
  NOT_CONFIGURED: 'EDGE_AUTH_NOT_CONFIGURED',
} as const;

type EdgeErrorCode = (typeof EDGE_ERROR_CODES)[keyof typeof EDGE_ERROR_CODES];

export function edgeHttpError(
  status: number,
  code: EdgeErrorCode,
  retryable = false,
): HttpException {
  const message =
    status === 429
      ? 'Enrollment verification is temporarily limited.'
      : status === 503
        ? 'Edge authentication is unavailable.'
        : status === 409
          ? 'Request state does not match current edge state.'
          : 'Edge credential could not be verified.';
  return new HttpException(
    {
      schemaVersion: 1,
      error: { code, message, retryable, requestId: 'edge-auth' },
    },
    status,
  );
}
