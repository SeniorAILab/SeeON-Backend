import type { ProvisioningSource } from '@prisma/client';

export type SpaceTypeValue =
  | 'ROOM'
  | 'HALLWAY'
  | 'PROGRAM_ROOM'
  | 'REHAB_ROOM'
  | 'DINING'
  | 'LOBBY'
  | 'NURSE_STATION'
  | 'ENTRANCE'
  | 'OFFICE'
  | 'STORAGE'
  | 'STAFF_LOUNGE'
  | 'ETC';
// Permissive by design: SpacesService enforces required-field/format rules
// via ConflictException (409); the global ValidationPipe must not preempt
// those with a 400, so these classes carry no class-validator decorators.
export class CreateSpaceRequestDto {
  floorId?: string;
  name?: string;
  type?: SpaceTypeValue;
  capacity?: number;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
export class UpdateSpaceRequestDto {
  floorId?: string;
  name?: string;
  type?: SpaceTypeValue;
  capacity?: number;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}

export interface SpaceResponseDto {
  id: string;
  facilityId: string;
  floorId: string;
  name: string;
  type: SpaceTypeValue;
  capacity: number;
  isActive: boolean;
  assignedStaff: string | null;
  provisioningSource: ProvisioningSource;
  createdAt: string;
}
