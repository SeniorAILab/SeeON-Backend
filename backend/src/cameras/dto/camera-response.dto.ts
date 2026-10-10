import type { ProvisioningSource } from '@prisma/client';

export interface EdgeCameraMappingResponseDto {
  cameraId: string;
  spaceId: string;
  facilityId: string;
}

export interface CameraResponseDto {
  id: string;
  facilityId: string;
  spaceId: string;
  label: string;
  lastSeenAt: Date | null;
  online: boolean;
  provisioningSource: ProvisioningSource;
  createdAt: Date;
}
