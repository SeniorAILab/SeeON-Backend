export type MediaDownloadInterval = ReturnType<typeof setInterval>;

export abstract class MediaDownloadRuntime {
  abstract now(): Date;
  abstract every(
    milliseconds: number,
    callback: () => Promise<void> | void,
  ): MediaDownloadInterval;
  abstract cancel(interval: MediaDownloadInterval): void;
}
