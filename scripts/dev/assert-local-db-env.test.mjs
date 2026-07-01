import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = path.resolve('scripts/dev/assert-local-db-env.mjs');

async function writeEnvFile(name, content) {
  const dir = await mkdtemp(path.join(tmpdir(), 'local-db-env-'));
  const filePath = path.join(dir, name);
  await writeFile(filePath, content);
  return filePath;
}

test('Given a local env file When the DB guard runs Then it exits successfully', async () => {
  const envFilePath = await writeEnvFile(
    '.env.local',
    [
      'DATABASE_URL="postgresql://fall:fall@localhost:5432/fall_dev"',
      'DIRECT_URL="postgresql://fall:fall@127.0.0.1:5432/fall_dev"',
      '',
    ].join('\n'),
  );

  const result = spawnSync(process.execPath, [scriptPath, envFilePath], { encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /local Postgres/);
});

test('Given a prod-looking env file When the DB guard runs Then it blocks reset', async () => {
  const envFilePath = await writeEnvFile(
    '.env.host.prod',
    'DATABASE_URL="postgresql://fall:fall@localhost:5432/fall_dev"\n',
  );

  const result = spawnSync(process.execPath, [scriptPath, envFilePath], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Only .env.local is allowed/);
});

test('Given a remote DATABASE_URL When the DB guard runs Then it blocks reset', async () => {
  const envFilePath = await writeEnvFile(
    '.env.local',
    'DATABASE_URL="postgresql://fall:fall@db.example.com:5432/fall_dev"\n',
  );

  const result = spawnSync(process.execPath, [scriptPath, envFilePath], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL must point to localhost/);
});

test('Given a remote DIRECT_URL When the DB guard runs Then it blocks reset', async () => {
  const envFilePath = await writeEnvFile(
    '.env.local',
    [
      'DATABASE_URL="postgresql://fall:fall@localhost:5432/fall_dev"',
      'DIRECT_URL="postgresql://fall:fall@db.example.com:5432/fall_dev"',
      '',
    ].join('\n'),
  );

  const result = spawnSync(process.execPath, [scriptPath, envFilePath], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DIRECT_URL must point to localhost/);
});
