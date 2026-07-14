import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class FloorsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(facilityId: string) {
    return this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.floor.findMany({ orderBy: { orderIndex: 'asc' } }),
    );
  }

  findById(facilityId: string, id: string) {
    return this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.floor.findUnique({ where: { id } }),
    );
  }

  create(facilityId: string, data: Prisma.FloorUncheckedCreateInput) {
    return this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.floor.create({ data }),
    );
  }

  update(
    facilityId: string,
    id: string,
    data: Prisma.FloorUncheckedUpdateInput,
  ) {
    return this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.floor.update({ where: { id }, data }),
    );
  }

  countActiveSpaces(facilityId: string, floorId: string) {
    return this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.count({ where: { floorId, isActive: true } }),
    );
  }
  async countDescendantSpaceReferences(
    facilityId: string,
    floorId: string,
  ) {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      const spaceWhere = { floorId };
      const [cameras, alerts, events] = await Promise.all([
        tx.camera.count({ where: { space: spaceWhere } }),
        tx.alert.count({ where: { space: spaceWhere } }),
        tx.event.count({ where: { space: spaceWhere } }),
      ]);
      return cameras + alerts + events;
    });
  }

  deleteWithDescendants(facilityId: string, id: string) {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      const spaces = await tx.space.findMany({
        where: { floorId: id },
        select: { id: true },
      });
      const spaceIds = spaces.map((s) => s.id);
      if (spaceIds.length > 0) {
        await tx.space.deleteMany({ where: { floorId: id } });
      }
      await tx.floor.delete({ where: { id } });
    });
  }
}
