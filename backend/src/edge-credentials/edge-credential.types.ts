import type {
  EdgeCredentialLifecycle,
  EdgeInstallationState,
  Prisma,
} from '@prisma/client';

export type EdgePrincipal = {
  readonly tokenId: string;
  readonly facilityId: string;
  readonly edgeInstallationId: string;
  readonly enrollmentGeneration: number;
  readonly validationRunId?: string;
};

export interface EdgeAuthenticatedRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body?: unknown;
  readonly params?: Record<string, string | undefined>;
  readonly query?: Record<string, unknown>;
  readonly originalUrl?: string;
  edgePrincipal?: EdgePrincipal;
  edgeFacilityId?: string;
}

export type CredentialBinding = {
  readonly tokenId: string;
  readonly tokenDigest: string;
  readonly lifecycle: EdgeCredentialLifecycle;
  readonly expiresAt: Date | null;
  readonly graceExpiresAt: Date | null;
  readonly facilityId: string;
  readonly facilityCode: string | null;
  readonly facilityName: string;
  readonly serverRevision: number;
  readonly edgeInstallationId: string;
  readonly enrollmentGeneration: number;
  readonly currentGeneration: number;
  readonly installationDeactivatedAt: Date | null;
  readonly generationState: EdgeInstallationState;
  readonly clientInstallationRef: string | null;
};

export type GeneratedCredential = {
  readonly tokenId: string;
  readonly fullToken: string;
  readonly digest: string;
  readonly prefix: string;
};

export type MutationIdentity = {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly bodyHash: string;
  readonly actorUserId: string;
};

export type StoredOperationResult = Prisma.InputJsonObject;

export const EDGE_TOKEN_PATTERN =
  /^eft_v1\.([0-9A-HJKMNP-TV-Z]{12})\.([A-Za-z0-9_-]{43})$/;
export const FACILITY_CODE_PATTERN = /^NH-[0-9A-HJKMNP-TV-Z]{10}$/;
export const TOKEN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;
export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const EDGE_CREDENTIAL_LIFECYCLES = [
  'ACTIVE',
  'GRACE',
  'EXPIRED',
  'REVOKED',
] as const;
export type EdgeCredentialLifecycleName =
  (typeof EDGE_CREDENTIAL_LIFECYCLES)[number];
