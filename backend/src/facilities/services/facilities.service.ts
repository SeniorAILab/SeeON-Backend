import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role, type Facility } from '@prisma/client';
import type { UpdateFacilityRequestDto } from '../dto/facility.dto.js';
import { FacilitiesRepository } from '../repositories/facilities.repository.js';

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
