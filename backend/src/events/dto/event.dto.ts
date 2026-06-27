export interface RecordEventRequestDto {
  camera_id: string;
  type: string;
  detected_at: string;
  confidence?: number;
  facility_id?: string;
}
export interface RecordHeartbeatRequestDto {
  camera_id: string;
}

export interface RecordHeartbeatResponseDto {
  ok: true;
}

export interface RecordEventResponseDto {
  id: string;
  status: 'created' | 'duplicate';
}

export interface EventResponseDto {
  id: string;
  facilityId: string;
  cameraId: string;
  spaceId: string;
  type: string;
  confidence: number | null;
  detectedAt: Date;
  createdAt: Date;
  modifiedAt: Date;
}
