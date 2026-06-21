import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Floor } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { CreateFloorDto, UpdateFloorDto } from '../dto/floor.dto.js';

@Injectable()
export class FloorsService {
  constructor(private readonly prisma: PrismaService) {}
  async list(facilityId: string) {
    const floors = await this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.floor.findMany({ orderBy: { orderIndex: 'asc' } }),
    );
    return floors.map(presentFloor);
  }
  async create(facilityId: string, dto: CreateFloorDto) {
    const name = dto.name?.trim();
    if (!name)
      throw new ConflictException({
        error: 'conflict',
        message: 'name is required',
      });
    const floor = await this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.floor.create({
        data: {
          facilityId,
          name,
          orderIndex: Number(dto.orderIndex ?? 0),
          isActive: dto.isActive ?? true,
        },
      }),
    );
    return presentFloor(floor);
  }
  async update(facilityId: string, id: string, dto: UpdateFloorDto) {
    if (dto.name !== undefined && !dto.name.trim())
      throw new ConflictException({
        error: 'conflict',
        message: 'name is required',
      });
    await this.ensureExists(facilityId, id);
    const floor = await this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.floor.update({
        where: { id },
        data: {
          name: dto.name?.trim() ?? undefined,
          orderIndex: dto.orderIndex,
          isActive: dto.isActive,
        },
      }),
    );
    return presentFloor(floor);
  }
  async remove(facilityId: string, id: string) {
    await this.ensureExists(facilityId, id);
    const activeSpaces = await this.prisma.withFacilityContext(
      facilityId,
      (tx) => tx.space.count({ where: { floorId: id, isActive: true } }),
    );
    if (activeSpaces > 0)
      throw new ConflictException({
        error: 'conflict',
        message: 'Floor cannot be deleted while active spaces reference it',
      });
    // No active spaces remain. Any leftover spaces are soft-deleted
    // (isActive=false) rows still held by the ON DELETE RESTRICT composite FK,
    // so remove their zones and the inactive spaces inside one transaction
    // before deleting the floor to avoid a dangling FK error.
    await this.prisma.withFacilityContext(facilityId, async (tx) => {
      const spaces = await tx.space.findMany({
        where: { floorId: id },
        select: { id: true },
      });
      const spaceIds = spaces.map((s) => s.id);
      if (spaceIds.length > 0) {
        await tx.zone.deleteMany({ where: { spaceId: { in: spaceIds } } });
        await tx.space.deleteMany({ where: { floorId: id } });
      }
      await tx.floor.delete({ where: { id } });
    });
  }
  private async ensureExists(facilityId: string, id: string) {
    const floor = await this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.floor.findUnique({ where: { id } }),
    );
    if (!floor)
      throw new NotFoundException({
        error: 'not_found',
        message: 'Floor not found',
      });
  }
}
export function presentFloor(floor: Floor) {
  return {
    id: floor.id,
    facilityId: floor.facilityId,
    name: floor.name,
    orderIndex: floor.orderIndex,
    isActive: floor.isActive,
    createdAt: floor.createdAt.toISOString(),
  };
}
