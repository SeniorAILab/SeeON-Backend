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
POSTGRES_USER=fall_prod_admin
POSTGRES_PASSWORD=prod-admin-password-32chars
POSTGRES_DB=fall_prod
APP_DB_USER=fall_app
APP_DB_PASSWORD=prod-app-password-32chars
DATABASE_URL=postgresql://fall_app:prod-app-password-32chars@db:5432/fall_prod?schema=public
DIRECT_URL=postgresql://fall_prod_admin:prod-admin-password-32chars@db:5432/fall_prod?schema=public
SESSION_JWT_SECRET=prod-dummy-session-secret-minimum-32-chars
KAKAO_REST_API_KEY=prod-kakao-rest-api-key
KAKAO_CLIENT_SECRET=prod-kakao-client-secret
KAKAO_REDIRECT_URI=https://senai.example.com/auth/kakao/callback
KAKAO_SCOPES=talk_message
KAKAO_TOKEN_ENC_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
BACKEND_IMAGE=ghcr.io/seniorailab/eldercare-fall-ai/backend:test
FRONT_IMAGE=ghcr.io/seniorailab/eldercare-fall-ai/front:test
`;

const completeEdgeEnv = `ML_SERVING_PORT=8000
EDGE_CAMERA_CONFIG=./ml/config/ml-worker.example.yaml
API_BACKEND_ALERT_URL=https://senai.example.com/ingest/alerts
API_BACKEND_HEARTBEAT_URL=https://senai.example.com/ingest/heartbeat
API_INGEST_KEY_ID=edge-prod-key
API_INGEST_SECRET=edge-prod-secret-minimum-32-chars
API_EDGE_RELAY_TOKEN=edge-relay-token-minimum-32-chars
API_CAMERA_INVENTORY=[{"camera_id":"cam-edge-01","facility_id":"facility-prod","resident_id":"resident-prod"}]
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
        ['requires'],
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
        'prod-kakao-client-secret',
        'talk_message',
        'ghcr.io/seniorailab/eldercare-fall-ai/backend:test',
        'ghcr.io/seniorailab/eldercare-fall-ai/front:test',
        'pull_policy: always',
      ]);

      const edgeConfig = requireSuccess(
        'edge prod config',
        ['-f', 'compose.edge.yaml', 'config'],
        edgeEnvPath,
      );
      assertRequiredFragments('edge prod config', edgeConfig, [
        'ml-api',
        'ml-worker',
        'worker.edge_worker',
        '/run/secrets/ml-worker.yaml',
        'ml/config/ml-worker.example.yaml',
        'API_BACKEND_ALERT_URL: https://senai.example.com/ingest/alerts',
        'API_BACKEND_HEARTBEAT_URL: https://senai.example.com/ingest/heartbeat',
        'API_INGEST_KEY_ID: edge-prod-key',
        'API_INGEST_SECRET: edge-prod-secret-minimum-32-chars',
        'API_EDGE_RELAY_TOKEN: edge-relay-token-minimum-32-chars',
        'API_CAMERA_INVENTORY:',
        'RELAY_TOKEN: edge-relay-token-minimum-32-chars',
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
