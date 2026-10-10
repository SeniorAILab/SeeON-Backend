import type { OnApplicationBootstrap } from '@nestjs/common';
import { ClipStorageReconciliationError } from '../errors/clip-storage-reconciliation.error.js';
import type {
  ClipReconciliationReport,
  ClipStorageReference,
} from '../clip-storage.types.js';

export interface ClipStorageReferenceReader {
  listAll(): Promise<readonly ClipStorageReference[]>;
}

export interface ClipStorageReconciler {
  reconcile(
    references: readonly ClipStorageReference[],
  ): Promise<ClipReconciliationReport>;
}

export type ClipStorageBootDependencies = {
  readonly storage: ClipStorageReconciler;
  readonly references: ClipStorageReferenceReader;
  readonly eventClipsEnabled: boolean;
};

export class ClipStorageBootReconcilerService implements OnApplicationBootstrap {
  constructor(private readonly dependencies: ClipStorageBootDependencies) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.dependencies.eventClipsEnabled) return;
    const references = await this.dependencies.references.listAll();
    const report = await this.dependencies.storage.reconcile(references);
    if (
      report.missingReferences.length > 0 ||
      report.corruptReferences.length > 0
    ) {
      throw new ClipStorageReconciliationError(report);
    }
  }
}
