interface MlConfigCameraDto {
  id: string;
  spaceId: string;
  label: string;
  rtspUrl: string | null;
  online: boolean;
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

export interface UpdateNightWindowRequestDto {
  start: string;
  end: string;
  tz: string;
}
