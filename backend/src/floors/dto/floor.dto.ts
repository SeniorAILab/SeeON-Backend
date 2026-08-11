import type { ProvisioningSource } from '@prisma/client';

// Permissive by design: FloorsService enforces required-field rules via
// ConflictException (409); the global ValidationPipe must not preempt those
// with a 400, so these classes carry no class-validator decorators.
export class CreateFloorRequestDto {
  name?: string;
  orderIndex?: number;
  isActive?: boolean;
  facilityId?: string;
}
export class UpdateFloorRequestDto {
  name?: string;
  orderIndex?: number;
  isActive?: boolean;
  facilityId?: string;
}

export interface FloorResponseDto {
  id: string;
  facilityId: string;
  name: string;
  orderIndex: number;
  isActive: boolean;
  provisioningSource: ProvisioningSource;
  createdAt: string;
}
