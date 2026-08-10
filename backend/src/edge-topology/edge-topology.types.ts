import type { EdgePrincipal } from '../edge-credentials/edge-credential.types.js';

export type CanonicalCamera = {
  readonly edgeRef: string;
  readonly label: string;
};

export type CanonicalRoom = {
  readonly edgeRef: string;
  readonly name: string;
  readonly type: 'ROOM';
  readonly capacity: number;
  readonly legacyCanonicalSpaceId?: string;
  readonly cameras: readonly CanonicalCamera[];
};

export type CanonicalFloor = {
  readonly edgeRef: string;
  readonly name: string;
  readonly orderIndex: number;
  readonly rooms: readonly CanonicalRoom[];
};

export type CanonicalSnapshot = {
  readonly schemaVersion: 1;
  readonly edgeInstallationId: string;
  readonly enrollmentGeneration: number;
  readonly clientRevision: number;
  readonly expectedServerRevision: number;
  readonly floors: readonly CanonicalFloor[];
};

export type EntityCounts = {
  created: number;
  updated: number;
  unchanged: number;
  reactivated: number;
};

export type MutationResult = {
  readonly floors: EntityCounts;
  readonly rooms: EntityCounts;
  readonly cameras: EntityCounts;
};

export type TransferItem = {
  readonly kind: 'FLOOR' | 'ROOM' | 'CAMERA';
  readonly edgeRef: string;
  readonly canonicalId: string;
  readonly parentCanonicalId: string | null;
};

export type OmittedRefs = {
  readonly cameras: readonly string[];
  readonly rooms: readonly string[];
  readonly floors: readonly string[];
};

export type ApplySnapshotInput = {
  readonly snapshotId: string;
  readonly bodyHash: string;
  readonly snapshot: CanonicalSnapshot;
  readonly principal: EdgePrincipal;
  readonly now: Date;
};

export type ConfirmSnapshotInput = {
  readonly snapshotId: string;
  readonly confirmationId: string;
  readonly digest: string;
  readonly expectedServerRevision: number;
  readonly principal: EdgePrincipal;
  readonly now: Date;
};

export function emptyMutationResult(): MutationResult {
  return {
    floors: emptyCounts(),
    rooms: emptyCounts(),
    cameras: emptyCounts(),
  };
}

function emptyCounts(): EntityCounts {
  return { created: 0, updated: 0, unchanged: 0, reactivated: 0 };
}
