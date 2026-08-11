import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role, type EdgeInstallation, type Facility } from '@prisma/client';
import type {
  EdgeConnectionState,
  FacilityEdgeStatusResponseDto,
  UpdateFacilityRequestDto,
} from '../dto/facility.dto.js';
import { FacilitiesRepository } from '../repositories/facilities.repository.js';

// 5 minutes = 10 missed relay ticks (Edge pushes per-camera heartbeats every
// 30s; see backend/app/lifespan.py:585, _backend_heartbeat_relay_sec default
// 30.0). Deliberately looser than the Edge's own internal stale bar of 90s
// (DEFAULT_STALE_AFTER_SEC in features/status/heartbeat_store.py:22) because
// effective_relay_interval_sec widens under backoff, so a transient Hub blip
// can legitimately stretch gaps past 90s without the Edge actually being
// down. A tighter Hub threshold would paint healthy, recovering Edges as
// STALE. Do not tighten this without re-verifying the Edge relay cadence.
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export type FacilityListUser = {
  readonly role: Role;
  readonly facilityId: string | null;
};

@Injectable()
export class FacilitiesService {
  constructor(private readonly facilitiesRepository: FacilitiesRepository) {}

  async current(facilityId: string) {
    const facility =
      await this.facilitiesRepository.getByFacilityId(facilityId);
    if (!facility) throwFacilityNotFound();
    return presentFacility(facility);
  }

  async getScoped(id: string, effectiveFacilityId: string) {
    if (id !== effectiveFacilityId) {
      throwFacilityNotFound();
    }
    return this.current(id);
  }

  async listForUser(user: FacilityListUser) {
    if (user.role === Role.SUPER_ADMIN) {
      return (await this.facilitiesRepository.listAll()).map(presentFacility);
    }
    if (!user.facilityId) {
      throw new ForbiddenException('Facility context required');
    }
    return (
      await this.facilitiesRepository.listByFacilityId(user.facilityId)
    ).map(presentFacility);
  }

  /**
   * Compact Edge status block for the facility admin screen: connection
   * state, last heartbeat, last topology sync, and healthy camera count.
   * A facility is CONNECTED when it has an active (non-deactivated) Edge
   * installation whose last heartbeat is within HEARTBEAT_STALE_MS; STALE
   * when enrolled but the heartbeat is missing/older than that; NOT_ENROLLED
   * when no active installation exists. No heartbeat cadence is documented
   * elsewhere in this repo, so this threshold is a conservative assumption —
   * flagged for product to confirm against the actual Edge heartbeat interval.
   */
  async getEdgeStatus(
    facilityId: string,
  ): Promise<FacilityEdgeStatusResponseDto> {
    const [installation, cameraHealth] = await Promise.all([
      this.facilitiesRepository.findActiveEdgeInstallation(facilityId),
      this.facilitiesRepository.getCameraHealthCounts(facilityId),
    ]);
    return {
      connectionState: deriveConnectionState(installation),
      lastHeartbeatAt: installation?.lastHeartbeatAt?.toISOString() ?? null,
      lastSyncedAt: installation?.lastSyncedAt?.toISOString() ?? null,
      healthyCameraCount: cameraHealth.healthy,
      totalCameraCount: cameraHealth.total,
    };
  }

  async update(facilityId: string, dto: UpdateFacilityRequestDto) {
    if (dto.name !== undefined && !dto.name.trim()) {
      throw new ConflictException({
        error: 'conflict',
        message: 'name is required',
      });
    }
    const facility = await this.facilitiesRepository.updateByFacilityId(
      facilityId,
      {
        name: dto.name?.trim() ?? undefined,
        address:
          dto.address !== undefined ? dto.address?.trim() || null : undefined,
        phone: dto.phone !== undefined ? dto.phone?.trim() || null : undefined,
      },
    );
    return presentFacility(facility);
  }
}

function deriveConnectionState(
  installation: EdgeInstallation | null,
): EdgeConnectionState {
  if (installation === null) return 'NOT_ENROLLED';
  if (
    installation.lastHeartbeatAt !== null &&
    Date.now() - installation.lastHeartbeatAt.getTime() <= HEARTBEAT_STALE_MS
  ) {
    return 'CONNECTED';
  }
  return 'STALE';
}

function throwFacilityNotFound(): never {
  throw new NotFoundException({
    error: 'not_found',
    message: 'Facility not found',
  });
}

function presentFacility(facility: Facility) {
  return {
    id: facility.id,
    name: facility.name,
    address: facility.address,
    phone: facility.phone,
    createdAt: facility.createdAt.toISOString(),
  };
}
