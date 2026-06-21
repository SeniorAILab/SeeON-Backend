import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class FacilitiesRepository {
  constructor(private readonly prisma: PrismaService) {}

  getByFacilityId(facilityId: string) {
    return this.prisma.db.facility.findUnique({
      where: { id: facilityId },
    });
  }

  updateByFacilityId(facilityId: string, data: Prisma.FacilityUpdateInput) {
    return this.prisma.db.facility.update({
      where: { id: facilityId },
      data,
    });
  }
}
