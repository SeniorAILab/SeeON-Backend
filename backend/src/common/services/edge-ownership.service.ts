import { ConflictException } from '@nestjs/common';
import { ProvisioningSource } from '@prisma/client';

/**
 * Shared write guard for floors/spaces/cameras: once a row's topology is
 * owned by an enrolled Edge installation (provisioningSource EDGE), Hub
 * admin surfaces must not mutate it — including name/capacity edits,
 * floorId/spaceId reassignment, and delete/soft-delete. The Edge is the
 * sole writer for its own structure; Hub only reflects it.
 *
 * This is an application-layer guard in front of the DB backstop
 * (`require_edge_ownership_transfer` trigger, migration
 * 20260810060000_edge_enrollment_topology_persistence), which only fires on
 * a PRODUCT→EDGE transition and does not cover ordinary mutations of an
 * already-EDGE row (name/capacity/floorId/spaceId/isActive changes, or
 * DELETE). Put the check here so every caller — controller, legacy edge
 * mapping endpoint, future callers — is covered without copy-pasting it.
 */
export function assertProductOwned(entity: {
  readonly provisioningSource: ProvisioningSource;
}): void {
  if (entity.provisioningSource === ProvisioningSource.EDGE) {
    throw new ConflictException({
      error: 'edge_owned',
      message:
        '이 항목은 현장 Edge가 관리하는 구조입니다. Hub에서 직접 수정하거나 삭제할 수 없습니다.',
    });
  }
}
