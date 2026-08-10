import { Injectable } from '@nestjs/common';

export type MediaDownloadInterval = ReturnType<typeof setInterval>;

export abstract class MediaDownloadRuntime {
  abstract now(): Date;
  abstract every(
    milliseconds: number,
    callback: () => Promise<void> | void,
  ): MediaDownloadInterval;
  abstract cancel(interval: MediaDownloadInterval): void;
}

@Injectable()
export class SystemMediaDownloadRuntime extends MediaDownloadRuntime {
  now(): Date {
    return new Date();
  }

  every(
    milliseconds: number,
    callback: () => Promise<void> | void,
  ): MediaDownloadInterval {
    const interval = setInterval(() => void callback(), milliseconds);
    interval.unref();
    return interval;
  }

  cancel(interval: MediaDownloadInterval): void {
    clearInterval(interval);
  }
}
