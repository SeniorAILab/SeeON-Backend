import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJsonUrl = new URL('../../package.json', import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'));
const scripts = packageJson.scripts;

test('Given root package scripts When daily dev commands are inspected Then they are owner-level and MECE', () => {
  assert.equal(scripts['dev:front'], 'pnpm --filter front dev');
  assert.equal(scripts['dev:backend'], 'node scripts/dev/dev-local.mjs backend');
  assert.equal(
    scripts['dev:backend:fresh'],
    'node scripts/dev/dev-local.mjs backend --reset',
  );
  assert.equal(scripts['dev:ml'], 'pnpm dev:ml:api');

  assert.equal(Object.hasOwn(scripts, 'dev:ml-api'), false);
  assert.equal(Object.hasOwn(scripts, 'dev:ml-worker'), false);
  assert.equal(Object.hasOwn(scripts, 'dev:demo'), false);
});

test('Given root package scripts When backend dependencies are inspected Then DB and Prisma commands are backend-owned', () => {
  assert.equal(scripts['dev:backend:app'], 'pnpm --filter backend start:dev');
  assert.equal(scripts['backend:db:up'], 'docker compose --env-file .env.local up -d db');
  assert.equal(scripts['backend:db:down'], 'docker compose down');
  assert.equal(scripts['backend:db:reset'], 'node scripts/db/reset-local.mjs');
  assert.equal(scripts['backend:prisma:generate'], 'pnpm --filter backend run prisma:generate');
  assert.equal(scripts['backend:prisma:migrate'], 'pnpm --filter backend run prisma:migrate');
  assert.equal(scripts['backend:prisma:seed'], 'pnpm --filter backend run prisma:seed');

  assert.equal(Object.hasOwn(scripts, 'db:up'), false);
  assert.equal(Object.hasOwn(scripts, 'db:down'), false);
  assert.equal(Object.hasOwn(scripts, 'prisma:generate'), false);
  assert.equal(Object.hasOwn(scripts, 'prisma:migrate'), false);
  assert.equal(Object.hasOwn(scripts, 'prisma:seed'), false);
});

test('Given root package scripts When ML component commands are inspected Then they live under dev:ml namespace', () => {
  assert.equal(
    scripts['dev:ml:api'],
    'uv run --directory ml uvicorn api.main:app --reload --host 127.0.0.1 --port 8000',
  );
  assert.equal(
    scripts['dev:ml:worker'],
    'uv run --directory ml python -m worker --config config/ml-worker.local.yaml',
  );
  assert.equal(scripts['dev:ml:demo'], 'uv run --directory ml --group demo streamlit run demo/app.py');
});
