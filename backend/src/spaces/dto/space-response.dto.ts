import type { ProvisioningSource } from '@prisma/client';
import type { SpaceTypeValue } from '../space.types.js';

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
