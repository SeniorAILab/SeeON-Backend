import { SpaceType } from '@prisma/client';
export interface CreateSpaceDto {
  floorId?: string;
  name?: string;
  type?: SpaceType;
  capacity?: number;
  cameraId?: string | null;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
export interface UpdateSpaceDto {
  floorId?: string;
  name?: string;
  type?: SpaceType;
  capacity?: number;
  cameraId?: string | null;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
