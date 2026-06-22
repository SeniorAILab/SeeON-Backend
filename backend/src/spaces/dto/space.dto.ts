import type { SpaceType } from '@prisma/client';
export interface CreateSpaceDto {
  floorId?: string;
  name?: string;
  type?: SpaceType;
  capacity?: number;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
export interface UpdateSpaceDto {
  floorId?: string;
  name?: string;
  type?: SpaceType;
  capacity?: number;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
