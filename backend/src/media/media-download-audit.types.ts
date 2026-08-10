import type { Role } from '@prisma/client';

export type ProcessLease = {
  readonly processId: string;
  readonly now: Date;
  readonly leaseExpiresAt: Date;
};

export type StartDownloadAudit = {
  readonly id: string;
  readonly facilityId: string;
  readonly clipId: string;
  readonly alertId: string;
  readonly actorUserId: string;
  readonly actorRole: Role;
  readonly requestId: string;
  readonly httpStatus: 200 | 206;
  readonly rangeStart: number | null;
  readonly rangeEnd: number | null;
  readonly bytesPlanned: number;
  readonly processId: string;
  readonly now: Date;
  readonly streamLeaseExpiresAt: Date;
};

export type DownloadAuditLease = {
  readonly id: string;
  readonly facilityId: string;
  readonly processId: string;
  readonly leaseVersion: number;
};

export type RenewDownloadAudit = DownloadAuditLease & {
  readonly now: Date;
  readonly streamLeaseExpiresAt: Date;
};

export type CompleteDownloadAudit = DownloadAuditLease & {
  readonly now: Date;
  readonly bytesActual: number;
};

export type AbortDownloadAudit = CompleteDownloadAudit & {
  readonly reason: string;
};

export type ExpiredDownloadAudit = {
  readonly id: string;
  readonly facilityId: string;
  readonly processId: string;
  readonly leaseVersion: number;
};

export type RecoverDownloadAudit = ExpiredDownloadAudit & {
  readonly recoveryProcessId: string;
  readonly now: Date;
};
