import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SpaceType } from '@prisma/client';
import type { Space } from '@prisma/client';
import { assertProductOwned } from '../../common/edge-ownership-guard.js';
import type {
  CreateSpaceRequestDto,
  SpaceResponseDto,
  SpaceTypeValue,
  UpdateSpaceRequestDto,
} from '../dto/space.dto.js';
import { SpacesRepository } from '../repositories/spaces.repository.js';

@Injectable()
export class SpacesService {
  constructor(private readonly spacesRepository: SpacesRepository) {}

  async list(
    facilityId: string,
    filters: {
      floorId?: string;
      type?: SpaceTypeValue;
      isActive?: boolean;
    } = {},
  ) {
    const spaces = await this.spacesRepository.list(facilityId, {
      ...filters,
      type: filters.type,
    });
    return spaces.map(presentSpace);
  }

  async getOne(facilityId: string, id: string) {
    const space = await this.spacesRepository.findById(facilityId, id);
    if (!space)
      throw new NotFoundException({
        error: 'not_found',
        message: 'Space not found',
      });
    return presentSpace(space);
  }

  async create(facilityId: string, dto: CreateSpaceRequestDto) {
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
    const space = await this.spacesRepository.create(facilityId, {
      facilityId,
      floorId,
      name,
      type,
      capacity,
      isActive: dto.isActive,
      assignedStaff:
        dto.assignedStaff !== undefined
          ? dto.assignedStaff?.trim() || null
          : undefined,
    });
    return presentSpace(space);
  }

  async update(facilityId: string, id: string, dto: UpdateSpaceRequestDto) {
    const existing = await this.requireExisting(facilityId, id);
    assertProductOwned(existing);
    const data = normalizeSpaceUpdate(dto);
    const space = await this.spacesRepository.update(facilityId, id, data);
    return presentSpace(space);
  }

  async remove(facilityId: string, id: string) {
    const existing = await this.requireExisting(facilityId, id);
    assertProductOwned(existing);
    const space = await this.spacesRepository.softDelete(facilityId, id);
    return presentSpace(space);
  }

  private async requireExisting(facilityId: string, id: string) {
    const space = await this.spacesRepository.findById(facilityId, id);
    if (!space)
      throw new NotFoundException({
        error: 'not_found',
        message: 'Space not found',
      });
    return space;
  }
}

function normalizeSpaceUpdate(dto: UpdateSpaceRequestDto) {
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
    isActive: dto.isActive,
    assignedStaff:
      dto.assignedStaff !== undefined
        ? dto.assignedStaff?.trim() || null
        : undefined,
  };
}

export function presentSpace(space: Space): SpaceResponseDto {
  return {
    id: space.id,
    facilityId: space.facilityId,
    floorId: space.floorId,
    name: space.name,
    type: space.type,
    capacity: space.capacity,
    isActive: space.isActive,
    assignedStaff: space.assignedStaff,
    provisioningSource: space.provisioningSource,
    createdAt: space.createdAt.toISOString(),
  };
}
