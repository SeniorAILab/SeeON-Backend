import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const PRODUCTION_ENV_VALUES = new Set(['prod', 'production']);

export function parseEnvText(text) {
  const env = new Map();

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const assignment = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(assignment);
    if (!match) {
      continue;
    }

    env.set(match[1], stripMatchingQuotes(match[2].trim()));
  }

  return env;
}

export function assertLocalDatabaseEnv(envFilePath, env) {
  const basename = path.basename(envFilePath);
  if (basename !== '.env.local') {
    throw new Error(`Only .env.local is allowed for local DB reset; got ${basename}`);
  }

  rejectProductionMode(env);
  assertLocalPostgresUrl(env, 'DATABASE_URL', true);
  assertLocalPostgresUrl(env, 'DIRECT_URL', false);
}

async function run(argv) {
  const envFilePath = argv[0] ?? '.env.local';
  const envText = await readFile(envFilePath, 'utf8');
  const env = parseEnvText(envText);

  assertLocalDatabaseEnv(envFilePath, env);
  console.log(`[assert-local-db-env] ${envFilePath} points to local Postgres`);
}

function stripMatchingQuotes(value) {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

function rejectProductionMode(env) {
  for (const name of ['NODE_ENV', 'APP_ENV']) {
    const value = env.get(name)?.toLowerCase();
    if (value && PRODUCTION_ENV_VALUES.has(value)) {
      throw new Error(`${name}=${value} is not allowed for local DB reset`);
    }
  }
}

function assertLocalPostgresUrl(env, name, required) {
  const value = env.get(name);
  if (!value) {
    if (required) {
      throw new Error(`${name} must be set for local DB reset`);
    }
    return;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }

  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }

  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`${name} must point to localhost/127.0.0.1 for local DB reset; got ${url.hostname}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (import.meta.url === invokedPath) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`[assert-local-db-env] ${error.message}`);
    process.exitCode = 1;
  });
}
