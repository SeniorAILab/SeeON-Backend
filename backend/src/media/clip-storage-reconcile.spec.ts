import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClipStorageService } from './clip-storage.service.js';
import type { ClipInspector, ClipStorageConfig } from './clip-storage.types.js';

const inspector: ClipInspector = {
  inspect: () => Promise.resolve({ codec: 'h264', durationMs: 1_000 }),
};

describe('ClipStorageService boot reconciliation', () => {
  let rootDir: string;
  let service: ClipStorageService;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-reconcile-'));
    const config: ClipStorageConfig = {
      rootDir,
      maximumBytes: 1024 * 1024,
      minimumFreeBytes: 0n,
      lockRetryCount: 2,
      lockRetryDelayMs: 1,
    };
    service = new ClipStorageService({ config, inspector });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('removes temp, lock, and unreferenced final orphans after restart', async () => {
    // Given: a crash left staging, a lock, one referenced final, and one orphan final.
    const kept = Buffer.from('kept');
    const keptHash = digest(kept);
    const keptKey = `facility-1/clip-kept/${keptHash}.mp4`;
    const orphanKey = `facility-1/clip-orphan/${digest(Buffer.from('orphan'))}.mp4`;
    await writeFixture(
      path.join(rootDir, '.staging/facility-1/clip-kept/a.part'),
      'temp',
    );
    await writeFixture(
      path.join(rootDir, '.locks/facility-1/clip-kept.lock'),
      'lock',
    );
    await writeFixture(path.join(rootDir, keptKey), kept);
    await writeFixture(path.join(rootDir, orphanKey), 'orphan');

    // When: boot reconciliation receives the durable database reference set.
    const report = await service.reconcile([
      { storageKey: keptKey, sha256: keptHash, sizeBytes: kept.length },
    ]);

    // Then: only the referenced exact bytes survive.
    expect(report.removedTemporaryFiles).toEqual([
      '.staging/facility-1/clip-kept/a.part',
    ]);
    expect(report.removedLockFiles).toEqual([
      '.locks/facility-1/clip-kept.lock',
    ]);
    expect(report.removedOrphanFiles).toEqual([orphanKey]);
    expect(report.missingReferences).toEqual([]);
    expect(report.corruptReferences).toEqual([]);
    await expect(fs.readFile(path.join(rootDir, keptKey))).resolves.toEqual(
      kept,
    );
    await expect(fs.stat(path.join(rootDir, orphanKey))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports missing and corrupt durable references without deleting evidence', async () => {
    // Given: one database reference is missing and one final differs from metadata.
    const corruptKey = `facility-1/clip-corrupt/${'a'.repeat(64)}.mp4`;
    await writeFixture(path.join(rootDir, corruptKey), 'different');
    const missingKey = `facility-1/clip-missing/${'b'.repeat(64)}.mp4`;

    // When: reconciliation inspects both references.
    const report = await service.reconcile([
      { storageKey: corruptKey, sha256: 'a'.repeat(64), sizeBytes: 9 },
      { storageKey: missingKey, sha256: 'b'.repeat(64), sizeBytes: 9 },
    ]);

    // Then: readiness blockers are explicit and corrupt evidence is preserved.
    expect(report.missingReferences).toEqual([missingKey]);
    expect(report.corruptReferences).toEqual([corruptKey]);
    await expect(fs.readFile(path.join(rootDir, corruptKey))).resolves.toEqual(
      Buffer.from('different'),
    );
  });
});

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeFixture(
  filePath: string,
  bytes: string | Buffer,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
}
