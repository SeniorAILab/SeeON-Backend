import { ClipStorageBootReconcilerService } from './services/clip-storage-boot-reconciler.service.js';
import { ClipStorageReconciliationError } from './errors/clip-storage-reconciliation.error.js';
import type { ClipReconciliationReport } from './clip-storage.types.js';

const cleanReport: ClipReconciliationReport = {
  removedTemporaryFiles: [],
  removedLockFiles: [],
  removedOrphanFiles: [],
  missingReferences: [],
  corruptReferences: [],
};

describe('ClipStorageBootReconcilerService', () => {
  it('does not inspect storage while the feature is disabled', async () => {
    // Given: boot uses disabled event clips.
    const listAll = jest.fn();
    const reconcile = jest.fn();
    const reconciler = new ClipStorageBootReconcilerService({
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
    const reconciler = new ClipStorageBootReconcilerService({
      eventClipsEnabled: true,
      references: { listAll },
      storage: { reconcile },
    });

    // When: application bootstrap runs.
    await reconciler.onApplicationBootstrap();

    // Then: the exact durable reference set is reconciled once.
    expect(reconcile).toHaveBeenCalledWith(references);
  });

  it.each(['missingReferences', 'corruptReferences'] as const)(
    'fails enabled startup and preserves the report for %s',
    async (failureKind) => {
      const missingKey = `facility-1/clip-1/${'b'.repeat(64)}.mp4`;
      const listAll = jest.fn().mockResolvedValue([]);
      const report: ClipReconciliationReport = {
        ...cleanReport,
        [failureKind]: [missingKey],
      };
      const reconcile = jest.fn().mockResolvedValue(report);
      const reconciler = new ClipStorageBootReconcilerService({
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
        expect(error.report).toBe(report);
        expect(error.report[failureKind]).toEqual([missingKey]);
        expect(error.message).toBe(
          'clip storage reconciliation found missing or corrupt media',
        );
      }
    },
  );
});
