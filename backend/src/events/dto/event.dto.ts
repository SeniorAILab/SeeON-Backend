export interface RecordEventRequestDto {
  camera_id: string;
  type: string;
  detected_at: string;
  confidence?: number;
  config_version?: number;
  model_version?: string;
  detector_version?: string;
  operating_threshold?: number;
  snapshot_key?: string | null;
  clock_source?: string;
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
  configVersion: number | null;
  modelVersion: string | null;
  detectorVersion: string | null;
  operatingThreshold: number | null;
  snapshotKey: string | null;
  clockSource: string | null;
}
