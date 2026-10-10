export type EdgeConnectionState = 'NOT_ENROLLED' | 'CONNECTED' | 'STALE';

export interface FacilityEdgeStatusResponseDto {
  connectionState: EdgeConnectionState;
  lastHeartbeatAt: string | null;
  lastSyncedAt: string | null;
  healthyCameraCount: number;
  totalCameraCount: number;
}
