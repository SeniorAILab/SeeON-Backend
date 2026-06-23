import { backendEnvFilePaths } from './env-files.js';
import { resolve } from 'node:path';

describe('backendEnvFilePaths', () => {
  it('uses repo-root .env.local as the only backend env file', () => {
    const repoRoot = resolve(process.cwd(), '..');

    expect(backendEnvFilePaths(process.cwd())).toEqual([
      resolve(repoRoot, '.env.local'),
    ]);
    expect(backendEnvFilePaths(repoRoot)).toEqual([
      resolve(repoRoot, '.env.local'),
    ]);
  });
});
