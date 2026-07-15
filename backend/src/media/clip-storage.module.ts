import { Module } from '@nestjs/common';
import { FfprobeClipInspector } from './clip-inspector.js';
import { ClipStorageBootReconciler } from './clip-storage-boot.js';
import { readClipStorageConfig } from './clip-storage.config.js';
import { ClipStorageReferenceRepository } from './clip-storage-reference.repository.js';
import { ClipStorageService } from './clip-storage.service.js';

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
      provide: ClipStorageBootReconciler,
      inject: [ClipStorageService, ClipStorageReferenceRepository],
      useFactory: (
        storage: ClipStorageService,
        references: ClipStorageReferenceRepository,
      ): ClipStorageBootReconciler =>
        new ClipStorageBootReconciler({
          storage,
          references,
          eventClipsEnabled: process.env.EVENT_CLIPS_ENABLED === 'true',
        }),
    },
  ],
  exports: [ClipStorageService],
})
export class ClipStorageModule {}
