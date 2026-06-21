import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SpaceType } from '@prisma/client';
import type { Space } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { CreateSpaceDto, UpdateSpaceDto } from '../dto/space.dto.js';

interface SpaceFilters {
  floorId?: string;
  type?: SpaceType;
  isActive?: boolean;
}

@Injectable()
export class SpacesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(facilityId: string, filters: SpaceFilters = {}) {
    const spaces = await this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.findMany({
        where: filters,
        orderBy: [{ floorId: 'asc' }, { name: 'asc' }],
      }),
    );
    return spaces.map(presentSpace);
  }

  async getOne(facilityId: string, id: string) {
    const space = await this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.findUnique({ where: { id } }),
    );
    if (!space)
      throw new NotFoundException({
        error: 'not_found',
        message: 'Space not found',
      });
    return presentSpace(space);
  }

  async create(facilityId: string, dto: CreateSpaceDto) {
    const floorId = dto.floorId;
    const name = dto.name?.trim();
    const type = dto.type;
    const capacity = dto.capacity;
    if (!floorId)
      throw new ConflictException({
        error: 'conflict',
        message: 'floorId is required',
      });
    if (!name)
      throw new ConflictException({
        error: 'conflict',
        message: 'name is required',
      });
    if (!type || !Object.values(SpaceType).includes(type))
      throw new ConflictException({
        error: 'conflict',
        message: 'type is required',
      });
    if (capacity === undefined)
      throw new ConflictException({
        error: 'conflict',
        message: 'capacity is required',
      });
    const space = await this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.create({
        data: {
          facilityId,
          floorId,
          name,
          type,
          capacity,
          cameraId:
            dto.cameraId !== undefined ? dto.cameraId?.trim() || null : null,
          isActive: dto.isActive,
          assignedStaff:
            dto.assignedStaff !== undefined
              ? dto.assignedStaff?.trim() || null
              : undefined,
        },
      }),
    );
    return presentSpace(space);
  }

  async update(facilityId: string, id: string, dto: UpdateSpaceDto) {
    await this.ensureExists(facilityId, id);
    const data = normalizeSpaceUpdate(dto);
    const space = await this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.update({ where: { id }, data }),
    );
    return presentSpace(space);
  }

  async remove(facilityId: string, id: string) {
    await this.ensureExists(facilityId, id);
    const space = await this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.update({ where: { id }, data: { isActive: false } }),
    );
    return presentSpace(space);
  }

  private async ensureExists(facilityId: string, id: string) {
    const space = await this.prisma.withFacilityContext(facilityId, (tx) =>
      tx.space.findUnique({ where: { id } }),
    );
    if (!space)
      throw new NotFoundException({
        error: 'not_found',
        message: 'Space not found',
      });
  }
}

function normalizeSpaceUpdate(dto: UpdateSpaceDto) {
  if (dto.name !== undefined && !dto.name.trim())
    throw new ConflictException({
      error: 'conflict',
      message: 'name is required',
    });
  if (dto.type !== undefined && !Object.values(SpaceType).includes(dto.type))
    throw new ConflictException({
      error: 'conflict',
      message: 'type is invalid',
    });
  return {
    floorId: dto.floorId,
    name: dto.name?.trim(),
    type: dto.type,
    capacity: dto.capacity,
    cameraId:
      dto.cameraId !== undefined ? dto.cameraId?.trim() || null : undefined,
    isActive: dto.isActive,
    assignedStaff:
      dto.assignedStaff !== undefined
        ? dto.assignedStaff?.trim() || null
        : undefined,
  };
}

export function presentSpace(space: Space) {
  return {
    id: space.id,
    facilityId: space.facilityId,
    floorId: space.floorId,
    name: space.name,
    type: space.type,
    capacity: space.capacity,
    cameraId: space.cameraId ?? null,
    isActive: space.isActive,
    assignedStaff: space.assignedStaff,
    createdAt: space.createdAt.toISOString(),
  };
}
