#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixedLocalKakaoTokenKey =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const completeHostEnv = `NODE_ENV=production
FRONT_ORIGIN=https://senai.example.com
ALERT_DASHBOARD_URL=https://senai.example.com
FRONT_PORT=3000
BACKEND_PORT=8080
POSTGRES_PORT=5432
POSTGRES_USER=fall_prod_admin
POSTGRES_PASSWORD=prod-admin-password-32chars
POSTGRES_DB=fall_prod
APP_DB_USER=fall_app_prod
APP_DB_PASSWORD=prod-app-password-32chars
SESSION_JWT_SECRET=prod-dummy-session-secret-minimum-32-chars
KAKAO_REST_API_KEY=prod-kakao-rest-api-key
KAKAO_REDIRECT_URI=https://senai.example.com/auth/kakao/callback
KAKAO_TOKEN_ENC_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`;

const completeEdgeEnv = `ML_SERVING_PORT=8000
ALERT_API_URL=https://senai.example.com/ingest/alerts
INGEST_KEY_ID=edge-camera-key-id
INGEST_SECRET=edge-camera-secret
DEMO_RESIDENT_ID=demo-resident-prod
DEMO_FACILITY_ID=demo-facility-prod
`;

const forbiddenHostFragments = [
  'fall_dev',
  'fall_app:fall_app',
  'postgresql://fall:fall@',
  'http://localhost',
  'dev-placeholder',
  fixedLocalKakaoTokenKey,
  'VITE_USE_MOCK: "true"',
  'VITE_USE_MOCK: true',
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
    const emptyEdgeEnvPath = join(dir, 'empty-edge.env');
    const edgeEnvPath = join(dir, 'edge.env');
    writeFileSync(emptyHostEnvPath, '');
    writeFileSync(hostEnvPath, completeHostEnv);
    writeFileSync(emptyEdgeEnvPath, '');
    writeFileSync(edgeEnvPath, completeEdgeEnv);
    run({ emptyHostEnvPath, hostEnvPath, emptyEdgeEnvPath, edgeEnvPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function verify() {
  withTempEnvFiles(
    ({ emptyHostEnvPath, hostEnvPath, emptyEdgeEnvPath, edgeEnvPath }) => {
      requireFailure(
        'host prod missing env',
        ['--profile', 'full', '-f', 'compose.yaml', '-f', 'compose.prod.yaml', 'config'],
        emptyHostEnvPath,
        ['required in prod'],
      );

      requireFailure(
        'edge prod missing env',
        ['-f', 'compose.edge.yaml', 'config'],
        emptyEdgeEnvPath,
        ['edge requires'],
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
        'fall_app_prod',
        'https://senai.example.com',
        'VITE_USE_MOCK: "false"',
      ]);

      const edgeConfig = requireSuccess(
        'edge prod config',
        ['-f', 'compose.edge.yaml', 'config'],
        edgeEnvPath,
      );
      assertRequiredFragments('edge prod config', edgeConfig, [
        'https://senai.example.com/ingest/alerts',
        'edge-camera-key-id',
        'demo-resident-prod',
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
