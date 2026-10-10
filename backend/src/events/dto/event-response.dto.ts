export interface RecordHeartbeatResponseDto {
  ok: true;
}

export type RecordEventResponseDto =
  | {
      readonly id: string;
      readonly status: 'created' | 'duplicate';
    }
  | {
      readonly id: string;
      readonly event_id: string;
      readonly edge_event_id: string;
      readonly status: 'accepted';
    };

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
export interface PaginatedEventsResponseDto {
  items: EventResponseDto[];
  nextCursor: string | null;
}
