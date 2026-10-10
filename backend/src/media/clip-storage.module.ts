import { Module } from '@nestjs/common';
import { FfprobeClipInspector } from './adapters/ffprobe-clip-inspector.adapter.js';
import { ClipStorageBootReconcilerService } from './services/clip-storage-boot-reconciler.service.js';
import { readClipStorageConfig } from './config/clip-storage.config.js';
import { ClipStorageReferenceRepository } from './repositories/clip-storage-reference.repository.js';
import { ClipStorageService } from './services/clip-storage.service.js';

@Module({
  providers: [
    FfprobeClipInspector,
    ClipStorageReferenceRepository,
    {
      provide: ClipStorageService,
      inject: [FfprobeClipInspector],
      useFactory: (inspector: FfprobeClipInspector): ClipStorageService =>
        new ClipStorageService({
          config: readClipStorageConfig(),
          inspector,
        }),
    },
    {
      provide: ClipStorageBootReconcilerService,
      inject: [ClipStorageService, ClipStorageReferenceRepository],
      useFactory: (
        storage: ClipStorageService,
        references: ClipStorageReferenceRepository,
      ): ClipStorageBootReconcilerService =>
        new ClipStorageBootReconcilerService({
          storage,
          references,
          eventClipsEnabled: process.env.EVENT_CLIPS_ENABLED === 'true',
        }),
    },
  ],
  exports: [ClipStorageService],
})
export class ClipStorageModule {}
