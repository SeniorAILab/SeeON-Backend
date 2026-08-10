import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  UUID_V7_PATTERN,
  type EdgePrincipal,
} from '../edge-credentials/edge-credential.types.js';
import type {
  EdgeTopologyConfirmationRequestDto,
  EdgeTopologySnapshotRequestDto,
} from './dto/edge-topology.dto.js';
import { canonicalSnapshot, snapshotHash } from './edge-topology-canonical.js';
import { EdgeTopologyConfirmationRepository } from './edge-topology-confirmation.repository.js';
import {
  TOPOLOGY_ERROR_CODES,
  TopologyDomainError,
  topologyHttpError,
} from './edge-topology.errors.js';
import { EdgeTopologyRepository } from './edge-topology.repository.js';

@Injectable()
export class EdgeTopologyService {
  constructor(
    private readonly repository: EdgeTopologyRepository,
    private readonly confirmations: EdgeTopologyConfirmationRepository,
  ) {}

  async apply(
    snapshotId: string,
    body: EdgeTopologySnapshotRequestDto,
    principal: EdgePrincipal,
  ) {
    try {
      requireSnapshotId(snapshotId);
      const snapshot = canonicalSnapshot(body);
      return await this.repository.apply({
        snapshotId,
        bodyHash: snapshotHash(snapshot),
        snapshot,
        principal,
        now: new Date(),
      });
    } catch (error: unknown) {
      throw mapTopologyError(error);
    }
  }

  async confirm(
    snapshotId: string,
    body: EdgeTopologyConfirmationRequestDto,
    principal: EdgePrincipal,
  ) {
    try {
      requireSnapshotId(snapshotId);
      return await this.confirmations.confirm({
        snapshotId,
        confirmationId: body.confirmationId,
        digest: body.digest,
        expectedServerRevision: body.expectedServerRevision,
        principal,
        now: new Date(),
      });
    } catch (error: unknown) {
      throw mapTopologyError(error);
    }
  }
}

function requireSnapshotId(snapshotId: string): void {
  if (!UUID_V7_PATTERN.test(snapshotId)) {
    throw new TopologyDomainError(400, TOPOLOGY_ERROR_CODES.INVALID_SCHEMA);
  }
}

function mapTopologyError(error: unknown): Error {
  if (error instanceof TopologyDomainError) {
    return topologyHttpError(error.status, error.code);
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2003' || error.code === 'P2025')
  ) {
    return topologyHttpError(409, TOPOLOGY_ERROR_CODES.TOPOLOGY_CONFLICT);
  }
  if (error instanceof Error) return error;
  return topologyHttpError(409, TOPOLOGY_ERROR_CODES.TOPOLOGY_CONFLICT);
}
