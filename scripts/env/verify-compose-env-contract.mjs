#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const completeHostEnv = `NODE_ENV=production
FRONT_ORIGINS=https://seeon.senai.example.com,http://198.51.100.1
ALERT_DASHBOARD_URL=https://senai.example.com
POSTGRES_USER=fall_prod_admin
POSTGRES_PASSWORD=prod-admin-password-32chars
POSTGRES_DB=fall_prod
APP_DB_USER=fall_app
APP_DB_PASSWORD=prod-app-password-32chars
DATABASE_URL=postgresql://fall_app:prod-app-password-32chars@db:5432/fall_prod?schema=public
DIRECT_URL=postgresql://fall_prod_admin:prod-admin-password-32chars@db:5432/fall_prod?schema=public
SESSION_JWT_SECRET=prod-dummy-session-secret-minimum-32-chars
EDGE_TOKEN_PEPPER=prod-dummy-edge-token-pepper-32chars
EDGE_LEGACY_COMPAT_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=prod-alerts@example.com
SMTP_PASSWORD=prod-smtp-app-password-32chars
SMTP_FROM=Eldercare Safety <prod-alerts@example.com>
SMTP_SECURE=false
NOKYANG_ADMIN_PASSWORD=prod-nokyang-password
EDGE_FACILITY_TOKEN=prod-edge-facility-token-32-chars
BACKEND_IMAGE=eldercare-backend:0123456789abcdef0123456789abcdef01234567
FRONT_IMAGE=eldercare-front:0123456789abcdef0123456789abcdef01234567\nMEDIA_RETENTION_DAYS=60\nMEDIA_MIN_FREE_BYTES=1073741824\nMEDIA_CLIP_MAX_BYTES=268435456
`;
const implicitSecureHostEnv = completeHostEnv
  .replace('SMTP_PORT=587\n', 'SMTP_PORT=465\n')
  .replace('SMTP_SECURE=false\n', '');


const forbiddenHostFragments = [
  'fall_dev',
  'fall_app:fall_app',
  'postgresql://fall:fall@',
  'http://localhost',
  'dev-placeholder',
  'DEMO_LOGIN_PASSWORD',
  'VITE_USE_MOCK: "true"',
  'VITE_USE_MOCK: true',
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

function parseComposeJson(label, output) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new VerificationError(
      `${label} did not produce valid JSON`,
      error instanceof Error ? error.message : '',
    );
  }
}

function assertHostComposeContract(config) {
  const services = config.services;
  if (services === null || typeof services !== 'object' || Array.isArray(services)) {
    throw new VerificationError('host prod JSON config has no service map');
  }

  const serviceNames = Object.keys(services).sort();
  const expectedServiceNames = ['backend', 'db', 'front'];
  if (
    serviceNames.length !== expectedServiceNames.length ||
    serviceNames.some((name, index) => name !== expectedServiceNames[index])
  ) {
    throw new VerificationError(
      'host prod service set must be exactly db, backend, front',
      `Found: ${serviceNames.join(', ')}`,
    );
  }

  const { backend, db, front } = services;
  const backendEnvironment = backend.environment;
  if (
    backendEnvironment === null ||
    typeof backendEnvironment !== 'object' ||
    Array.isArray(backendEnvironment)
  ) {
    throw new VerificationError('host prod backend has no environment map');
  }
  if (
    backendEnvironment.EDGE_TOKEN_PEPPER !==
    'prod-dummy-edge-token-pepper-32chars'
  ) {
    throw new VerificationError(
      'host prod backend must receive EDGE_TOKEN_PEPPER',
    );
  }
  if (String(backendEnvironment.EDGE_LEGACY_COMPAT_ENABLED) !== 'true') {
    throw new VerificationError(
      'host prod backend must keep EDGE_LEGACY_COMPAT_ENABLED true',
    );
  }
  const backendImage = backend.image;
  const frontImage = front.image;
  const backendMatch =
    typeof backendImage === 'string' &&
    /^eldercare-backend:([0-9a-f]{40})$/.exec(backendImage);
  const frontMatch =
    typeof frontImage === 'string' &&
    /^eldercare-front:([0-9a-f]{40})$/.exec(frontImage);
  if (!backendMatch || !frontMatch || backendMatch[1] !== frontMatch[1]) {
    throw new VerificationError(
      'host prod app images must use matching lowercase 40-character SHA tags',
      `backend: ${String(backendImage)}\nfront: ${String(frontImage)}`,
    );
  }

  if (db.pull_policy !== 'always') {
    throw new VerificationError('host prod db must always pull its image');
  }
  if (backend.pull_policy !== 'never' || front.pull_policy !== 'never') {
    throw new VerificationError('host prod app images must never be pulled');
  }

  const hasPublishedPorts = (service) =>
    Array.isArray(service.ports) && service.ports.length > 0;
  if (hasPublishedPorts(db) || hasPublishedPorts(backend)) {
    throw new VerificationError('host prod db and backend must not publish ports');
  }
  const frontPorts = front.ports;
  if (
    !Array.isArray(frontPorts) ||
    frontPorts.length !== 1 ||
    frontPorts[0].host_ip !== '127.0.0.1' ||
    frontPorts[0].published !== '3000' ||
    frontPorts[0].target !== 3000 ||
    frontPorts[0].protocol !== 'tcp'
  ) {
    throw new VerificationError(
      'host prod frontend must exclusively publish 127.0.0.1:3000',
      JSON.stringify(frontPorts),
    );
  }
}
function assertLocalComposeContract(config) {
  const backendEnvironment = config.services?.backend?.environment;
  if (
    backendEnvironment === null ||
    typeof backendEnvironment !== 'object' ||
    Array.isArray(backendEnvironment)
  ) {
    throw new VerificationError('local backend has no environment map');
  }
  if (backendEnvironment.EDGE_TOKEN_PEPPER !== '') {
    throw new VerificationError(
      'local backend must map EDGE_TOKEN_PEPPER without a default',
    );
  }
  // Fail-closed by default: the deprecated shared-token compatibility path
  // must never activate implicitly, only via an explicit opt-in value.
  if (String(backendEnvironment.EDGE_LEGACY_COMPAT_ENABLED ?? '') === 'true') {
    throw new VerificationError(
      'local backend must default EDGE_LEGACY_COMPAT_ENABLED to disabled',
    );
  }
  if (String(backendEnvironment.EDGE_LEGACY_FACILITY_ID ?? '') !== '') {
    throw new VerificationError(
      'local backend must default EDGE_LEGACY_FACILITY_ID to unset',
    );
  }
}
function assertLegacyEdgeTokenNotRequiredContract(config) {
  const backendEnvironment = config.services?.backend?.environment;
  if (
    backendEnvironment === null ||
    typeof backendEnvironment !== 'object' ||
    Array.isArray(backendEnvironment)
  ) {
    throw new VerificationError(
      'host prod no-legacy-edge config has no backend environment map',
    );
  }
  // The Hub must boot without the deprecated shared edge token or an
  // explicit legacy-compat opt-in: eft_v1 per-installation credentials are
  // the authoritative path and neither variable may block startup.
  if (String(backendEnvironment.EDGE_FACILITY_TOKEN ?? '') !== '') {
    throw new VerificationError(
      'host prod backend must boot without EDGE_FACILITY_TOKEN set',
    );
  }
  if (String(backendEnvironment.EDGE_LEGACY_COMPAT_ENABLED ?? '') === 'true') {
    throw new VerificationError(
      'host prod backend must default EDGE_LEGACY_COMPAT_ENABLED to disabled',
    );
  }
}

function assertSmtpSecureOmissionContract(config) {
  const smtpPort = config.services?.backend?.environment?.SMTP_PORT;
  const smtpSecure = config.services?.backend?.environment?.SMTP_SECURE;
  if (String(smtpPort) !== '465') {
    throw new VerificationError(
      'host prod SMTP omission config must pass port 465 to the backend',
      `SMTP_PORT: ${String(smtpPort)}`,
    );
  }
  if (smtpSecure !== undefined && smtpSecure !== '') {
    throw new VerificationError(
      'host prod SMTP omission config must preserve SMTP_SECURE as omitted or empty',
      `SMTP_SECURE: ${String(smtpSecure)}`,
    );
  }
}

function withTempEnvFiles(run) {
  const dir = mkdtempSync(join(tmpdir(), 'eldercare-env-contract-'));
  try {
    const emptyHostEnvPath = join(dir, 'empty-host.env');
    const hostEnvPath = join(dir, 'host.env');
    const missingPepperHostEnvPath = join(dir, 'missing-pepper-host.env');
    const implicitSecureHostEnvPath = join(dir, 'implicit-secure-host.env');
    const noLegacyEdgeHostEnvPath = join(dir, 'no-legacy-edge-host.env');
    writeFileSync(emptyHostEnvPath, '');
    writeFileSync(hostEnvPath, completeHostEnv);
    writeFileSync(
      missingPepperHostEnvPath,
      completeHostEnv.replace(/^EDGE_TOKEN_PEPPER=.*\n/m, ''),
    );
    writeFileSync(implicitSecureHostEnvPath, implicitSecureHostEnv);
    writeFileSync(
      noLegacyEdgeHostEnvPath,
      completeHostEnv
        .replace(/^EDGE_LEGACY_COMPAT_ENABLED=.*\n/m, '')
        .replace(/^EDGE_FACILITY_TOKEN=.*\n/m, ''),
    );
    run({
      emptyHostEnvPath,
      hostEnvPath,
      missingPepperHostEnvPath,
      implicitSecureHostEnvPath,
      noLegacyEdgeHostEnvPath,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function verify() {
  withTempEnvFiles(
    ({
      emptyHostEnvPath,
      hostEnvPath,
      missingPepperHostEnvPath,
      implicitSecureHostEnvPath,
      noLegacyEdgeHostEnvPath,
    }) => {
      const localConfigJson = requireSuccess(
        'local JSON config',
        ['--profile', 'full', '-f', 'compose.yaml', 'config', '--format', 'json'],
        emptyHostEnvPath,
      );
      assertLocalComposeContract(
        parseComposeJson('local JSON config', localConfigJson),
      );

      requireFailure(
        'host prod missing env',
        ['--profile', 'full', '-f', 'compose.yaml', '-f', 'compose.prod.yaml', 'config'],
        emptyHostEnvPath,
        ['required in prod'],
      );

      requireFailure(
        'host prod missing edge token pepper',
        ['--profile', 'full', '-f', 'compose.yaml', '-f', 'compose.prod.yaml', 'config'],
        missingPepperHostEnvPath,
        ['EDGE_TOKEN_PEPPER is required in prod'],
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
        'eldercare-backend:0123456789abcdef0123456789abcdef01234567',
        'eldercare-front:0123456789abcdef0123456789abcdef01234567',
        'host_ip: 127.0.0.1',
        'published: "3000"',
        'pull_policy: always',
        'pull_policy: never',
      ]);
      const hostConfigJson = requireSuccess(
        'host prod JSON config',
        [
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
        hostEnvPath,
      );
      assertHostComposeContract(parseComposeJson('host prod JSON config', hostConfigJson));
      const implicitSecureHostConfigJson = requireSuccess(
        'host prod SMTP omission JSON config',
        [
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
        implicitSecureHostEnvPath,
      );
      assertSmtpSecureOmissionContract(
        parseComposeJson(
          'host prod SMTP omission JSON config',
          implicitSecureHostConfigJson,
        ),
      );

      const noLegacyEdgeConfigJson = requireSuccess(
        'host prod config without legacy edge token or opt-in',
        [
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
        noLegacyEdgeHostEnvPath,
      );
      assertLegacyEdgeTokenNotRequiredContract(
        parseComposeJson(
          'host prod config without legacy edge token or opt-in',
          noLegacyEdgeConfigJson,
        ),
      );
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
