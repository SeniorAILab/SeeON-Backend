export interface CreateCameraRequestDto {
  label: string;
  spaceId: string;
}

export interface UpdateCameraRequestDto {
  label?: string;
  spaceId?: string;
}
