import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClipStorageService } from '../../src/media/clip-storage.service.js';
import type {
  ClipInspector,
  ClipStorageDependencies,
} from '../../src/media/clip-storage.types.js';

class AcceptingInspector implements ClipInspector {
  inspect() {
    return Promise.resolve({ codec: 'h264' as const, durationMs: 1_000 });
  }
}

export type RealEventMediaStorage = {
  readonly rootDir: string;
  readonly service: ClipStorageService;
  readonly listFiles: () => Promise<readonly string[]>;
  readonly cleanup: () => Promise<void>;
};

export async function createEventMediaStorage(
  overrides: Partial<
    Pick<ClipStorageDependencies, 'inspector' | 'availableBytes'>
  > = {},
): Promise<RealEventMediaStorage> {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'event-media-store-'),
  );
  const service = new ClipStorageService({
    config: {
      rootDir,
      maximumBytes: 1024 * 1024,
      minimumFreeBytes: 0n,
      lockRetryCount: 1_000,
      lockRetryDelayMs: 1,
    },
    inspector: overrides.inspector ?? new AcceptingInspector(),
    availableBytes: overrides.availableBytes,
  });
  return {
    rootDir,
    service,
    listFiles: () => listFiles(rootDir),
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}

async function listFiles(rootDir: string): Promise<readonly string[]> {
  return collectFiles(rootDir, rootDir);
}

async function collectFiles(
  rootDir: string,
  directory: string,
): Promise<readonly string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(rootDir, absolute)));
    } else {
      files.push(path.relative(rootDir, absolute).split(path.sep).join('/'));
    }
  }
  return files.sort();
}
