import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Facility } from '@prisma/client';
import type { UpdateFacilityRequestDto } from '../dto/facility.dto.js';
import { FacilitiesRepository } from '../repositories/facilities.repository.js';

@Injectable()
export class FacilitiesService {
  constructor(private readonly facilitiesRepository: FacilitiesRepository) {}

  async current(facilityId: string) {
    const facility =
      await this.facilitiesRepository.getByFacilityId(facilityId);
    if (!facility)
      throw new NotFoundException({
        error: 'not_found',
        message: 'Facility not found',
      });
    return presentFacility(facility);
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

function presentFacility(facility: Facility) {
  return {
    id: facility.id,
    name: facility.name,
    code: facility.code,
    address: facility.address,
    phone: facility.phone,
    createdAt: facility.createdAt.toISOString(),
  };
}
