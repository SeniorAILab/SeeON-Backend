import {
  ClipStorageBootReconciler,
  ClipStorageReconciliationError,
} from './clip-storage-boot.js';
import type { ClipReconciliationReport } from './clip-storage.types.js';

const cleanReport: ClipReconciliationReport = {
  removedTemporaryFiles: [],
  removedLockFiles: [],
  removedOrphanFiles: [],
  missingReferences: [],
  corruptReferences: [],
};

describe('ClipStorageBootReconciler', () => {
  it('does not inspect storage while the feature is disabled', async () => {
    // Given: boot uses disabled event clips.
    const listAll = jest.fn();
    const reconcile = jest.fn();
    const reconciler = new ClipStorageBootReconciler({
      eventClipsEnabled: false,
      references: { listAll },
      storage: { reconcile },
    });

    // When: application bootstrap runs.
    await reconciler.onApplicationBootstrap();

    // Then: neither the database nor volume is touched.
    expect(listAll).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('reconciles durable references before enabled application readiness', async () => {
    // Given: one durable reference exactly matches the volume.
    const references = [
      {
        storageKey: `facility-1/clip-1/${'a'.repeat(64)}.mp4`,
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
      },
    ];
    const listAll = jest.fn().mockResolvedValue(references);
    const reconcile = jest.fn().mockResolvedValue(cleanReport);
    const reconciler = new ClipStorageBootReconciler({
      eventClipsEnabled: true,
      references: { listAll },
      storage: { reconcile },
    });

    // When: application bootstrap runs.
    await reconciler.onApplicationBootstrap();

    // Then: the exact durable reference set is reconciled once.
    expect(reconcile).toHaveBeenCalledWith(references);
  });

  it('fails enabled startup when referenced media is missing', async () => {
    // Given: reconciliation reports a missing durable file.
    const missingKey = `facility-1/clip-1/${'b'.repeat(64)}.mp4`;
    const listAll = jest.fn().mockResolvedValue([]);
    const reconcile = jest.fn().mockResolvedValue({
      ...cleanReport,
      missingReferences: [missingKey],
    });
    const reconciler = new ClipStorageBootReconciler({
      eventClipsEnabled: true,
      references: { listAll },
      storage: { reconcile },
    });

    // When: application bootstrap runs.
    const action = reconciler.onApplicationBootstrap();

    // Then: readiness fails closed with the reconciliation report.
    try {
      await action;
      throw new Error('expected startup reconciliation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ClipStorageReconciliationError);
      if (!(error instanceof ClipStorageReconciliationError)) throw error;
      expect(error.report.missingReferences).toEqual([missingKey]);
    }
  });
});
