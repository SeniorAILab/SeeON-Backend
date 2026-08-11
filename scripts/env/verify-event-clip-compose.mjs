#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const validHostEnv = `FRONT_ORIGIN=https://example.test
ALERT_DASHBOARD_URL=https://example.test
POSTGRES_USER=prod_admin
POSTGRES_PASSWORD=prod-admin-password
POSTGRES_DB=prod_db
APP_DB_USER=fall_app
APP_DB_PASSWORD=prod-app-password
DATABASE_URL=postgresql://fall_app:prod-app-password@db:5432/prod_db?schema=public
DIRECT_URL=postgresql://prod_admin:prod-admin-password@db:5432/prod_db?schema=public
SESSION_JWT_SECRET=prod-session-secret-minimum-32-characters
EDGE_TOKEN_PEPPER=prod-edge-token-pepper
SMTP_HOST=mail.example.test
SMTP_USER=alerts@example.test
SMTP_PASSWORD=prod-mail-password
EDGE_FACILITY_TOKEN=prod-edge-token
BACKEND_IMAGE=eldercare-backend:0123456789abcdef0123456789abcdef01234567
FRONT_IMAGE=eldercare-front:0123456789abcdef0123456789abcdef01234567
MEDIA_RETENTION_DAYS=60
MEDIA_MIN_FREE_BYTES=1073741824
MEDIA_CLIP_MAX_BYTES=268435456
`;

class VerificationError extends Error {}

function composeConfig(envFile) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      envFile,
      '--profile',
      'full',
      '-f',
      'compose.yaml',
      '-f',
      'compose.prod.yaml',
      'config',
      '--format',
      'json',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new VerificationError('event clip compose config failed');
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new VerificationError(
      error instanceof Error
        ? `event clip compose config was not JSON: ${error.message}`
        : 'event clip compose config was not JSON',
    );
  }
}

function positiveInteger(name, value) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new VerificationError(`${name} must be a positive integer`);
  }
  return Number(text);
}

function assertContract(config) {
  const backend = config.services?.backend;
  if (backend === null || typeof backend !== 'object') {
    throw new VerificationError('backend service is required');
  }
  const environment = backend.environment;
  if (environment === null || typeof environment !== 'object') {
    throw new VerificationError('backend environment is required');
  }
  if (String(environment.EVENT_CLIPS_ENABLED) !== 'false') {
    throw new VerificationError('EVENT_CLIPS_ENABLED must default to false');
  }
  if (environment.MEDIA_CLIP_DIR !== '/app/backend/clips') {
    throw new VerificationError('MEDIA_CLIP_DIR must use the fixed backend clip path');
  }
  const retentionDays = positiveInteger(
    'MEDIA_RETENTION_DAYS',
    environment.MEDIA_RETENTION_DAYS,
  );
  if (retentionDays < 60) {
    throw new VerificationError(
      'MEDIA_RETENTION_DAYS must be an integer of at least 60',
    );
  }
  const minimumFreeBytes = positiveInteger(
    'MEDIA_MIN_FREE_BYTES',
    environment.MEDIA_MIN_FREE_BYTES,
  );
  const maximumClipBytes = positiveInteger(
    'MEDIA_CLIP_MAX_BYTES',
    environment.MEDIA_CLIP_MAX_BYTES,
  );
  if (minimumFreeBytes < maximumClipBytes) {
    throw new VerificationError(
      'MEDIA_MIN_FREE_BYTES must cover at least one maximum-sized clip',
    );
  }

  const clipMounts = Array.isArray(backend.volumes)
    ? backend.volumes.filter((mount) => mount.target === '/app/backend/clips')
    : [];
  if (
    clipMounts.length !== 1 ||
    clipMounts[0].type !== 'volume' ||
    clipMounts[0].read_only === true
  ) {
    throw new VerificationError(
      'backend clip storage must be one writable named-volume mount',
    );
  }
  const source = clipMounts[0].source;
  if (
    typeof source !== 'string' ||
    config.volumes === null ||
    typeof config.volumes !== 'object' ||
    !(source in config.volumes)
  ) {
    throw new VerificationError('backend clip storage source must be declared');
  }
  for (const serviceName of ['db', 'front']) {
    const mounts = config.services?.[serviceName]?.volumes;
    if (
      Array.isArray(mounts) &&
      mounts.some((mount) => mount.target === '/app/backend/clips')
    ) {
      throw new VerificationError(
        `backend clip storage must not be mounted into ${serviceName}`,
      );
    }
  }
}

function expectInvalidRetention(config) {
  try {
    assertContract(config);
  } catch (error) {
    if (
      error instanceof VerificationError &&
      error.message === 'MEDIA_RETENTION_DAYS must be an integer of at least 60'
    ) {
      return;
    }
    throw error;
  }
  throw new VerificationError('59-day retention unexpectedly passed');
}

function assertStaticDefaults() {
  const hostExample = readFileSync('.env.host.prod.example', 'utf8');
  const frontDockerfile = readFileSync('front/Dockerfile', 'utf8');
  const jenkinsfile = readFileSync('Jenkinsfile', 'utf8');
  const expectedHostLines = [
    'EVENT_CLIPS_ENABLED=false',
    'VITE_EVENT_CLIPS_ENABLED=false',
    'MEDIA_RETENTION_DAYS=60',
    'MEDIA_MIN_FREE_BYTES=1073741824',
    'MEDIA_CLIP_MAX_BYTES=268435456',
  ];
  for (const line of expectedHostLines) {
    if (!hostExample.includes(line)) {
      throw new VerificationError(`host env example is missing ${line}`);
    }
  }
  if (
    !frontDockerfile.includes('ARG VITE_EVENT_CLIPS_ENABLED=false') ||
    !frontDockerfile.includes('ENV VITE_EVENT_CLIPS_ENABLED=$VITE_EVENT_CLIPS_ENABLED')
  ) {
    throw new VerificationError('frontend image flag must default to false');
  }
  if (
    !jenkinsfile.includes(
      '--build-arg VITE_EVENT_CLIPS_ENABLED="$VITE_EVENT_CLIPS_ENABLED"',
    )
  ) {
    throw new VerificationError('Jenkins must pass the validated frontend flag');
  }
}

function verify() {
  const dir = mkdtempSync(join(tmpdir(), 'event-clip-compose-'));
  try {
    const validPath = join(dir, 'valid.env');
    const shortRetentionPath = join(dir, 'short-retention.env');
    writeFileSync(validPath, validHostEnv);
    writeFileSync(
      shortRetentionPath,
      validHostEnv.replace('MEDIA_RETENTION_DAYS=60', 'MEDIA_RETENTION_DAYS=59'),
    );
    assertContract(composeConfig(validPath));
    expectInvalidRetention(composeConfig(shortRetentionPath));
    assertStaticDefaults();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  verify();
  console.log('event clip deployment contract verification passed');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'unknown verification failure');
  process.exit(1);
}
