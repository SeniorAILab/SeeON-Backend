import { IsString } from 'class-validator';

// Existing authenticated camera write endpoints are permissive by design:
// CamerasService enforces required-field/format rules via ConflictException
// (409), so the global ValidationPipe must not preempt those with a 400.
export class CreateCameraRequestDto {
  label!: string;
  spaceId!: string;
  // Write-only: RTSP endpoint for the camera. Settable on create/update but
  // never returned by any read/response DTO (see cameras.service toCameraDto)
  // and never logged. Plaintext in Phase-1; at-rest encryption is Phase-2.
  rtspUrl?: string | null;
}

export class UpdateCameraRequestDto {
  label?: string;
  spaceId?: string;
  // Write-only (see CreateCameraRequestDto).
  rtspUrl?: string | null;
}

export class EdgeCameraMappingRequestDto {
  @IsString()
  edge_camera_ref!: string;

  @IsString()
  label!: string;

  @IsString()
  spaceId!: string;
}

export interface EdgeCameraMappingResponseDto {
  cameraId: string;
  spaceId: string;
  facilityId: string;
}
