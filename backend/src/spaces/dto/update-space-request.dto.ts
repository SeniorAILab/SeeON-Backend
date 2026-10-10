import type { SpaceTypeValue } from '../space.types.js';

export class UpdateSpaceRequestDto {
  floorId?: string;
  name?: string;
  type?: SpaceTypeValue;
  capacity?: number;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
