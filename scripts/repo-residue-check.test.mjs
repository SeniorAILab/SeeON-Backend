import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('./repo-residue-check.mjs', import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-residue-check-'));
  return {
    root,
    cleanup() {
      rmSync(root, { force: true, recursive: true });
    },
    directory(path) {
      mkdirSync(join(root, path), { recursive: true });
    },
    file(path, contents = '') {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent) this.directory(parent);
      writeFileSync(join(root, path), contents);
    },
  };
}

function check(root, role, ...args) {
  return spawnSync(process.execPath, [checker, '--repo-role', role, '--root', root, ...args], {
    encoding: 'utf8',
  });
}

test('host role rejects ML paths, namespaces, and release semantics', () => {
  const repo = fixture();
  try {
    repo.directory('ml');
    repo.file('compose.edge.yaml');
    repo.file('scripts/release/images.mjs', 'Builds four same-SHA images\nml/Dockerfile.api\nghcr.io/seniorailab/eldercare-fall-ml/ml-api:test\n');
    const result = check(repo.root, 'host');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /host repository retains an ML runtime path/);
    assert.match(result.stderr, /ML GHCR namespace/);
    assert.match(result.stderr, /release entrypoint builds an ML image/);
    assert.match(result.stderr, /four-image ML release semantics/);
  } finally {
    repo.cleanup();
  }
});

test('host role requires a reason when an allowed residue path is declared', () => {
  const repo = fixture();
  try {
    repo.file('docs/history.txt', 'ghcr.io/seniorailab/eldercare-fall-ai/ml-api:old');
    repo.file('.env', 'ML_API_IMAGE=ghcr.io/seniorailab/eldercare-fall-ai/ml-api:local');
    assert.equal(check(repo.root, 'host').status, 1);
    const result = check(repo.root, 'host', '--allow', 'docs/history.txt:historical tombstone');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /allowed=1/);
  } finally {
    repo.cleanup();
  }
});

test('ml role enforces the flattened edge layout and rejects host coupling', () => {
  const repo = fixture();
  try {
    repo.file('compose.edge.yaml');
    repo.file('Dockerfile.api');
    repo.file('Dockerfile.worker');
    repo.directory('worker');
    repo.directory('api');
    repo.directory('contracts');
    repo.directory('scripts/edge-updater');
    repo.file('.github/workflows/edge-images.yml');
    execFileSync(process.execPath, [checker, '--repo-role', 'ml', '--root', repo.root]);

    repo.file('scripts/deploy/ncloud-deploy.sh', 'deploy:prod:manual');
    repo.file('old.txt', 'ghcr.io/seniorailab/eldercare-fall-ai/ml-worker:test');
    repo.directory('ml');
    const result = check(repo.root, 'ml');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /old ml\/ prefix/);
    assert.match(result.stderr, /old monorepo GHCR namespace/);
    assert.match(result.stderr, /coupled to host deployment/);
  } finally {
    repo.cleanup();
  }
});
