import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT_SENTINELS = ['pnpm-workspace.yaml', 'backend/package.json'];

function findRepoRoot(startDir: string): string {
  let currentDir = resolve(startDir);
  let parentDir = dirname(currentDir);
  while (currentDir !== parentDir) {
    if (
      REPO_ROOT_SENTINELS.every((sentinel) =>
        existsSync(join(currentDir, sentinel)),
      )
    ) {
      return currentDir;
    }
    currentDir = parentDir;
    parentDir = dirname(currentDir);
  }
  return resolve(startDir);
}

export function backendEnvFilePaths(startDir = process.cwd()): string[] {
  return [join(findRepoRoot(startDir), '.env.local')];
}
