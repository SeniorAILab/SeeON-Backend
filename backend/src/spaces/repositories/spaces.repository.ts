import { Injectable } from '@nestjs/common';
import type { Prisma, SpaceType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';

export interface SpaceFilters {
  floorId?: string;
  type?: SpaceType;
  isActive?: boolean;
}

@Injectable()
export class SpacesRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(facilityId: string, filters: SpaceFilters = {}) {
    return this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.findMany({
        where: filters,
        orderBy: [{ floorId: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  findById(facilityId: string, id: string) {
    return this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.findUnique({ where: { id } }),
    );
  }

  create(facilityId: string, data: Prisma.SpaceUncheckedCreateInput) {
    return this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.create({ data }),
    );
  }

  update(
    facilityId: string,
    id: string,
    data: Prisma.SpaceUncheckedUpdateInput,
  ) {
    return this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.update({ where: { id }, data }),
    );
  }

  softDelete(facilityId: string, id: string) {
    return this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.update({ where: { id }, data: { isActive: false } }),
    );
  }
}
