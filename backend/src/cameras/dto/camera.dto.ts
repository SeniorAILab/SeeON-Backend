export interface CreateCameraDto {
  label: string;
  spaceId: string;
  residentId?: string | null;
}

export interface UpdateCameraDto {
  label?: string;
  spaceId?: string;
  residentId?: string | null;
}
