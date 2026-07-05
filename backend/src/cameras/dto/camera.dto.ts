export interface CreateCameraRequestDto {
  label: string;
  spaceId: string;
  // Write-only: RTSP endpoint for the camera. Settable on create/update but
  // never returned by any read/response DTO (see cameras.service toCameraDto)
  // and never logged. Plaintext in Phase-1; at-rest encryption is Phase-2.
  rtspUrl?: string | null;
}

export interface UpdateCameraRequestDto {
  label?: string;
  spaceId?: string;
  // Write-only (see CreateCameraRequestDto).
  rtspUrl?: string | null;
}
