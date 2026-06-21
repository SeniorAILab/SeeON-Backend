import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Facility } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { UpdateFacilityDto } from '../dto/facility.dto.js';

@Injectable()
export class FacilitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async current(facilityId: string) {
    const facility = await this.prisma.db.facility.findUnique({
      where: { id: facilityId },
    });
    if (!facility)
      throw new NotFoundException({
        error: 'not_found',
        message: 'Facility not found',
      });
    return presentFacility(facility);
  }

  async update(facilityId: string, dto: UpdateFacilityDto) {
    if (dto.name !== undefined && !dto.name.trim()) {
      throw new ConflictException({
        error: 'conflict',
        message: 'name is required',
      });
    }
    const facility = await this.prisma.db.facility.update({
      where: { id: facilityId },
      data: {
        name: dto.name?.trim() ?? undefined,
        address:
          dto.address !== undefined ? dto.address?.trim() || null : undefined,
        phone: dto.phone !== undefined ? dto.phone?.trim() || null : undefined,
      },
    });
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
