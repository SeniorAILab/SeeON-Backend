import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Floor } from '@prisma/client';
import { assertProductOwned } from '../../common/edge-ownership-guard.js';
import type {
  CreateFloorRequestDto,
  FloorResponseDto,
  UpdateFloorRequestDto,
} from '../dto/floor.dto.js';
import { FloorsRepository } from '../repositories/floors.repository.js';

@Injectable()
export class FloorsService {
  constructor(private readonly floorsRepository: FloorsRepository) {}
  async list(facilityId: string) {
    const floors = await this.floorsRepository.list(facilityId);
    return floors.map(presentFloor);
  }
  async create(facilityId: string, dto: CreateFloorRequestDto) {
    const name = dto.name?.trim();
    if (!name)
      throw new ConflictException({
        error: 'conflict',
        message: 'name is required',
      });
    const floor = await this.floorsRepository.create(facilityId, {
      facilityId,
      name,
      orderIndex: Number(dto.orderIndex ?? 0),
      isActive: dto.isActive ?? true,
    });
    return presentFloor(floor);
  }
  async update(facilityId: string, id: string, dto: UpdateFloorRequestDto) {
    if (dto.name !== undefined && !dto.name.trim())
      throw new ConflictException({
        error: 'conflict',
        message: 'name is required',
      });
    const existing = await this.requireExisting(facilityId, id);
    assertProductOwned(existing);
    const floor = await this.floorsRepository.update(facilityId, id, {
      name: dto.name?.trim() ?? undefined,
      orderIndex: dto.orderIndex,
      isActive: dto.isActive,
    });
    return presentFloor(floor);
  }
  async remove(facilityId: string, id: string) {
    const existing = await this.requireExisting(facilityId, id);
    assertProductOwned(existing);
    const result = await this.floorsRepository.deleteWithDescendants(
      facilityId,
      id,
    );
    if (result.status === 'not_found')
      throw new NotFoundException({
        error: 'not_found',
        message: 'Floor not found',
      });
    if (result.status === 'active_spaces')
      throw new ConflictException({
        error: 'conflict',
        message: 'Floor cannot be deleted while active spaces reference it',
      });
    if (result.status === 'referenced_spaces')
      throw new ConflictException({
        error: 'conflict',
        message: '참조 이력이 있는 공간이 포함된 층은 삭제할 수 없습니다',
      });
  }
  private async requireExisting(facilityId: string, id: string) {
    const floor = await this.floorsRepository.findById(facilityId, id);
    if (!floor)
      throw new NotFoundException({
        error: 'not_found',
        message: 'Floor not found',
      });
    return floor;
  }
}
export function presentFloor(floor: Floor): FloorResponseDto {
  return {
    id: floor.id,
    facilityId: floor.facilityId,
    name: floor.name,
    orderIndex: floor.orderIndex,
    isActive: floor.isActive,
    provisioningSource: floor.provisioningSource,
    createdAt: floor.createdAt.toISOString(),
  };
}
