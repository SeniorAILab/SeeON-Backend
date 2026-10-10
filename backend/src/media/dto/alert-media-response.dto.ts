export type AlertMediaResponseDto =
  | {
      readonly status: 'PENDING';
      readonly alertId: string;
      readonly retryAfterSeconds: null;
    }
  | {
      readonly status: 'READY';
      readonly alertId: string;
      readonly clip: {
        readonly contentType: 'video/mp4';
        readonly detectedAt: Date;
        readonly clipStartAt: Date;
        readonly clipEndAt: Date;
        readonly durationSeconds: number;
      };
    }
  | { readonly status: 'UNAVAILABLE'; readonly alertId: string }
  | {
      readonly status: 'EXPIRED';
      readonly alertId: string;
      readonly expiredAt: Date;
    }
  | {
      readonly status: 'DELETED';
      readonly alertId: string;
      readonly deletedAt: Date;
    };
