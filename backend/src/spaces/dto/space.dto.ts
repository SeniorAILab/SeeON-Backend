export type SpaceTypeDto =
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
export interface CreateSpaceDto {
  floorId?: string;
  name?: string;
  type?: SpaceTypeDto;
  capacity?: number;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
export interface UpdateSpaceDto {
  floorId?: string;
  name?: string;
  type?: SpaceTypeDto;
  capacity?: number;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
