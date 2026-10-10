import { Injectable } from '@nestjs/common';
import {
  MediaDownloadRuntime,
  type MediaDownloadInterval,
} from '../ports/media-download-runtime.port.js';

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
