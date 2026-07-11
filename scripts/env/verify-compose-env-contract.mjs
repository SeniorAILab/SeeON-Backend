#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const completeHostEnv = `NODE_ENV=production
FRONT_ORIGIN=https://senai.example.com
ALERT_DASHBOARD_URL=https://senai.example.com
POSTGRES_USER=fall_prod_admin
POSTGRES_PASSWORD=prod-admin-password-32chars
POSTGRES_DB=fall_prod
APP_DB_USER=fall_app
APP_DB_PASSWORD=prod-app-password-32chars
DATABASE_URL=postgresql://fall_app:prod-app-password-32chars@db:5432/fall_prod?schema=public
DIRECT_URL=postgresql://fall_prod_admin:prod-admin-password-32chars@db:5432/fall_prod?schema=public
SESSION_JWT_SECRET=prod-dummy-session-secret-minimum-32-chars
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=prod-alerts@example.com
SMTP_PASSWORD=prod-smtp-app-password-32chars
SMTP_FROM=Eldercare Safety <prod-alerts@example.com>
SMTP_SECURE=false
NOKYANG_ADMIN_PASSWORD=prod-nokyang-password
EDGE_FACILITY_TOKEN=prod-edge-facility-token-32-chars
BACKEND_IMAGE=ghcr.io/seniorailab/eldercare-fall-ai/backend:test
FRONT_IMAGE=ghcr.io/seniorailab/eldercare-fall-ai/front:test
`;

const forbiddenHostFragments = [
  'fall_dev',
  'fall_app:fall_app',
  'postgresql://fall:fall@',
  'http://localhost',
  'dev-placeholder',
  'DEMO_LOGIN_PASSWORD',
  'VITE_USE_MOCK: "true"',
  'VITE_USE_MOCK: true',
  'published: "3000"',
  'published: "5432"',
  'published: "8080"',
  'dockerfile:',
  'build:',
];

class VerificationError extends Error {
  constructor(message, details = '') {
    super(details.length > 0 ? `${message}\n${details}` : message);
  }
}

function runDockerCompose(args, envFile) {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
      },
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function requireFailure(label, args, envFile, expectedFragments) {
  const result = runDockerCompose(args, envFile);
  if (result.status === 0) {
    throw new VerificationError(
      `${label} unexpectedly succeeded`,
      result.stdout,
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  for (const fragment of expectedFragments) {
    if (!output.includes(fragment)) {
      throw new VerificationError(
        `${label} failed for the wrong reason`,
        `Missing expected fragment: ${fragment}\n${output}`,
      );
    }
  }
}

function requireSuccess(label, args, envFile) {
  const result = runDockerCompose(args, envFile);
  if (result.status !== 0) {
    throw new VerificationError(`${label} failed`, result.stderr);
  }
  return result.stdout;
}

function assertForbiddenFragments(label, output, fragments) {
  const found = fragments.filter((fragment) => output.includes(fragment));
  if (found.length > 0) {
    throw new VerificationError(
      `${label} contains forbidden production defaults`,
      found.map((fragment) => `- ${fragment}`).join('\n'),
    );
  }
}

function assertRequiredFragments(label, output, fragments) {
  const missing = fragments.filter((fragment) => !output.includes(fragment));
  if (missing.length > 0) {
    throw new VerificationError(
      `${label} is missing required production fragments`,
      missing.map((fragment) => `- ${fragment}`).join('\n'),
    );
  }
}

function withTempEnvFiles(run) {
  const dir = mkdtempSync(join(tmpdir(), 'eldercare-env-contract-'));
  try {
    const emptyHostEnvPath = join(dir, 'empty-host.env');
    const hostEnvPath = join(dir, 'host.env');
    writeFileSync(emptyHostEnvPath, '');
    writeFileSync(hostEnvPath, completeHostEnv);
    run({ emptyHostEnvPath, hostEnvPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function verify() {
  withTempEnvFiles(
    ({ emptyHostEnvPath, hostEnvPath }) => {
      requireFailure(
        'host prod missing env',
        ['--profile', 'full', '-f', 'compose.yaml', '-f', 'compose.prod.yaml', 'config'],
        emptyHostEnvPath,
        ['required in prod'],
      );


      const hostConfig = requireSuccess(
        'host prod config',
        ['--profile', 'full', '-f', 'compose.yaml', '-f', 'compose.prod.yaml', 'config'],
        hostEnvPath,
      );
      assertForbiddenFragments('host prod config', hostConfig, forbiddenHostFragments);
      assertRequiredFragments('host prod config', hostConfig, [
        'NODE_ENV: production',
        'fall_prod',
        'fall_app',
        'postgresql://fall_app:prod-app-password-32chars@db:5432/fall_prod?schema=public',
        'https://senai.example.com',
        'smtp.gmail.com',
        'prod-alerts@example.com',
        'prod-smtp-app-password-32chars',
        'Eldercare Safety <prod-alerts@example.com>',
        'NOKYANG_ADMIN_PASSWORD: prod-nokyang-password',
        'EDGE_FACILITY_TOKEN: prod-edge-facility-token-32-chars',
        'ghcr.io/seniorailab/eldercare-fall-ai/backend:test',
        'ghcr.io/seniorailab/eldercare-fall-ai/front:test',
        'pull_policy: always',
      ]);

    },
  );
}

try {
  verify();
  console.log('env contract verification passed');
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
    process.exit(1);
  }
  console.error('unknown env contract verification failure');
  process.exit(1);
}
