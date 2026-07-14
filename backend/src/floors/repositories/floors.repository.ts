import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
export type FloorDeleteResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'active_spaces' }
  | { status: 'referenced_spaces' };

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

  async deleteWithDescendants(
    facilityId: string,
    id: string,
  ): Promise<FloorDeleteResult> {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      const floors = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "floors" WHERE id = ${id} FOR UPDATE
      `;
      if (floors.length === 0) return { status: 'not_found' };

      // Existing descendants are locked so restores and new history references
      // cannot interleave with the checks below. New placements conflict with
      // the floor row's FOR UPDATE lock through their foreign key.
      await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "spaces" WHERE "floor_id" = ${id} FOR UPDATE
      `;

      const activeSpaces = await tx.space.count({
        where: { floorId: id, isActive: true },
      });
      if (activeSpaces > 0) return { status: 'active_spaces' };

      const spaceWhere = { floorId: id };
      const [cameras, alerts, events] = await Promise.all([
        tx.camera.count({ where: { space: spaceWhere } }),
        tx.alert.count({ where: { space: spaceWhere } }),
        tx.event.count({ where: { space: spaceWhere } }),
      ]);
      if (cameras + alerts + events > 0) {
        return { status: 'referenced_spaces' };
      }

      await tx.space.deleteMany({ where: { floorId: id } });
      await tx.floor.delete({ where: { id } });
      return { status: 'deleted' };
    });
  }
}
