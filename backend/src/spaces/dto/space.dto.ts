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
export interface CreateSpaceRequestDto {
  floorId?: string;
  name?: string;
  type?: SpaceTypeValue;
  capacity?: number;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
export interface UpdateSpaceRequestDto {
  floorId?: string;
  name?: string;
  type?: SpaceTypeValue;
  capacity?: number;
  isActive?: boolean;
  assignedStaff?: string | null;
  facilityId?: string;
}
