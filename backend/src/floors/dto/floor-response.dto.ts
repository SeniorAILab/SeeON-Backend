import type { ProvisioningSource } from '@prisma/client';

export interface FloorResponseDto {
  id: string;
  facilityId: string;
  name: string;
  orderIndex: number;
  isActive: boolean;
  provisioningSource: ProvisioningSource;
  createdAt: string;
}
