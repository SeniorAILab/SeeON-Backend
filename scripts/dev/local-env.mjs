import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export const DEFAULT_LOCAL_ENV_FILE = '.env.local';

const ALLOWED_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ALLOWED_DB_NAMES = new Set(['fall_dev']);
const FORBIDDEN_ENV_FILES = new Set(['.env.host.prod', '.env.edge.prod']);

export class LocalEnvError extends Error {
  constructor(errors) {
    super(`Invalid local dev env:\n${errors.map((error) => `- ${error}`).join('\n')}`);
    this.name = 'LocalEnvError';
    this.errors = errors;
  }
}

export function parseCommonArgs(argv) {
  const parsed = {
    dryRun: false,
    envFile: DEFAULT_LOCAL_ENV_FILE,
    rest: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--env-file') {
      const value = argv[index + 1];
      if (!value) {
        throw new LocalEnvError(['--env-file requires a path']);
      }
      parsed.envFile = value;
      index += 1;
    } else {
      parsed.rest.push(arg);
    }
  }

  return parsed;
}

export function assertNoUnknownArgs(args, allowedFlags = []) {
  const allowed = new Set(allowedFlags);
  const unknownArgs = args.filter((arg) => !allowed.has(arg));
  if (unknownArgs.length > 0) {
    throw new LocalEnvError([
      `unknown argument(s): ${unknownArgs.join(', ')}`,
    ]);
  }
}

export async function loadAndValidateLocalEnv(envFile) {
  const resolvedEnvFile = resolve(envFile);
  const env = await readEnvFile(resolvedEnvFile);
  validateLocalEnv(env, resolvedEnvFile);
  return {
    env,
    resolvedEnvFile,
    summary: summarizeLocalEnv(env, resolvedEnvFile),
  };
}

export async function readEnvFile(envFile) {
  let text;
  try {
    text = await readFile(envFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new LocalEnvError([`${envFile} is missing`]);
    }
    throw error;
  }

  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex < 1) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    const value = stripEnvQuotes(line.slice(eqIndex + 1).trim());
    if (key) {
      env[key] = value;
    }
  }
  return env;
}

export function validateLocalEnv(env, envFile) {
  const errors = [];
  const envFileName = basename(envFile);

  if (FORBIDDEN_ENV_FILES.has(envFileName)) {
    errors.push(`${envFileName} is forbidden for local destructive commands`);
  }

  const nodeEnv = env.NODE_ENV?.trim();
  if (nodeEnv !== 'development') {
    errors.push('NODE_ENV must be development');
  }

  if (env.APP_ENV === 'production' || env.NODE_ENV === 'production') {
    errors.push('production env is not allowed');
  }

  validatePostgresUrl(env, 'DATABASE_URL', errors);
  validatePostgresUrl(env, 'DIRECT_URL', errors);

  if (errors.length > 0) {
    throw new LocalEnvError(errors);
  }
}

export function summarizeLocalEnv(env, envFile) {
  return {
    databaseUrl: summarizePostgresUrl(env.DATABASE_URL),
    directUrl: summarizePostgresUrl(env.DIRECT_URL),
    envFile,
    nodeEnv: env.NODE_ENV,
  };
}

export function printLocalEnvSummary(summary) {
  console.log(
    [
      'OK local dev env verified',
      `envFile=${summary.envFile}`,
      `NODE_ENV=${summary.nodeEnv}`,
      `DATABASE_URL=${summary.databaseUrl}`,
      `DIRECT_URL=${summary.directUrl}`,
    ].join(' '),
  );
}

function validatePostgresUrl(env, key, errors) {
  const value = env[key];
  if (!value) {
    errors.push(`${key} is required`);
    return;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${key} must be a valid PostgreSQL URL`);
    return;
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    errors.push(`${key} must use postgresql://`);
  }

  if (!ALLOWED_DB_HOSTS.has(url.hostname.toLowerCase())) {
    errors.push(`${key} host must be local, got ${url.hostname}`);
  }

  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!ALLOWED_DB_NAMES.has(dbName)) {
    errors.push(`${key} database must be fall_dev, got ${dbName || '<empty>'}`);
  }
}

function summarizePostgresUrl(value) {
  try {
    const url = new URL(value);
    const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return `${url.hostname}:${url.port || '5432'}/${dbName}`;
  } catch {
    return '<invalid>';
  }
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
