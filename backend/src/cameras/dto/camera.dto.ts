export interface CreateCameraDto {
  label: string;
  spaceId: string;
}

export interface UpdateCameraDto {
  label?: string;
  spaceId?: string;
}
