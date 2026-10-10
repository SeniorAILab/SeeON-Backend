interface MlConfigCameraDto {
  id: string;
  spaceId: string;
  label: string;
  rtspUrl: string | null;
  online: boolean;
  spaceName: string | null;
  floorName: string | null;
  createdAt: string;
}

export interface MlConfigResponseDto {
  configVersion: number;
  nightWindow: {
    start: string;
    end: string;
    tz: string;
  };
  cameras: MlConfigCameraDto[];
}
