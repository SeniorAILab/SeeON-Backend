#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoUnknownArgs,
  LocalEnvError,
  loadAndValidateLocalEnv,
  parseCommonArgs,
  printLocalEnvSummary,
} from './local-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const backendDir = resolve(repoRoot, 'backend');

async function main() {
  const [mode, ...restArgs] = process.argv.slice(2);
  if (mode !== 'backend' && mode !== 'local') {
    throw new LocalEnvError(['usage: node scripts/dev/dev-local.mjs backend|local [--reset] [--dry-run] [--env-file <path>]']);
  }

  const common = parseCommonArgs(restArgs);
  assertNoUnknownArgs(common.rest, ['--reset']);
  const reset = common.rest.includes('--reset');
  const { env, resolvedEnvFile, summary } = await loadAndValidateLocalEnv(
    common.envFile,
  );
  printLocalEnvSummary(summary);

  const childEnv = { ...process.env, ...env };
  await runDbUp(resolvedEnvFile, childEnv, common.dryRun);
  await waitForDb(resolvedEnvFile, env, childEnv, common.dryRun);

  if (reset) {
    await runNodeScript(
      'db:reset:local',
      ['scripts/db/reset-local.mjs', '--env-file', resolvedEnvFile],
      childEnv,
      common.dryRun,
    );
  } else {
    await runPnpm(
      'prisma:generate',
      ['exec', 'prisma', 'generate'],
      backendDir,
      childEnv,
      common.dryRun,
    );
    await runPnpm(
      'prisma:migrate',
      ['exec', 'prisma', 'migrate', 'dev'],
      backendDir,
      childEnv,
      common.dryRun,
    );
  }

  if (mode === 'backend') {
    await runLongRunning(
      [{ label: 'dev:backend', args: ['--filter', 'backend', 'start:dev'] }],
      childEnv,
      common.dryRun,
    );
  } else {
    await runLongRunning(
      [
        { label: 'dev:backend', args: ['--filter', 'backend', 'start:dev'] },
        { label: 'dev:front', args: ['--filter', 'front', 'dev'] },
      ],
      childEnv,
      common.dryRun,
    );
  }
}

function runDbUp(envFile, env, dryRun) {
  return runCommand(
    'db:up',
    'docker',
    ['compose', '--env-file', envFile, 'up', '-d', 'db'],
    repoRoot,
    env,
    dryRun,
  );
}

async function waitForDb(envFile, envFileValues, env, dryRun) {
  const postgresUser = envFileValues.POSTGRES_USER || 'fall';
  const postgresDb = envFileValues.POSTGRES_DB || 'fall_dev';
  const args = [
    'compose',
    '--env-file',
    envFile,
    'exec',
    '-T',
    'db',
    'pg_isready',
    '-U',
    postgresUser,
    '-d',
    postgresDb,
  ];

  if (dryRun) {
    console.log(`[dry-run] db:wait -> docker ${quoteArgs(args)}`);
    return;
  }

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const exitCode = await runCommandForStatus('docker', args, repoRoot, env);
    if (exitCode === 0) {
      return;
    }
    await sleep(1000);
  }
  throw new Error('db:wait failed: PostgreSQL did not become ready');
}

function runNodeScript(label, args, env, dryRun) {
  return runCommand(label, process.execPath, args, repoRoot, env, dryRun);
}

function runPnpm(label, args, cwd, env, dryRun) {
  return runCommand(label, 'pnpm', args, cwd, env, dryRun);
}

function runCommand(label, command, args, cwd, env, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] ${label} -> ${command} ${quoteArgs(args)}`);
    return Promise.resolve();
  }

  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      reject(
        new Error(
          `${label} failed with ${signal ? `signal ${signal}` : `exit ${code}`}`,
        ),
      );
    });
  });
}

function runCommandForStatus(command, args, cwd, env) {
  return new Promise((resolveStatus) => {
    const child = spawn(command, args, { cwd, env, stdio: 'ignore' });
    child.on('error', () => resolveStatus(1));
    child.on('exit', (code) => resolveStatus(code ?? 1));
  });
}

function runLongRunning(processes, env, dryRun) {
  if (dryRun) {
    for (const processInfo of processes) {
      console.log(`[dry-run] ${processInfo.label} -> pnpm ${quoteArgs(processInfo.args)}`);
    }
    return Promise.resolve();
  }

  return new Promise((resolveProcess, reject) => {
    let settled = false;
    const children = processes.map((processInfo) =>
      spawn('pnpm', processInfo.args, {
        cwd: repoRoot,
        env,
        stdio: 'inherit',
      }),
    );

    const shutdown = (signal) => {
      for (const child of children) {
        if (!child.killed) {
          child.kill(signal);
        }
      }
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    children.forEach((child, index) => {
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        shutdown('SIGTERM');
        reject(error);
      });
      child.on('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        shutdown('SIGTERM');
        if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') {
          resolveProcess();
          return;
        }
        reject(
          new Error(
            `${processes[index].label} exited with ${signal ? `signal ${signal}` : `exit ${code}`}`,
          ),
        );
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function quoteArgs(args) {
  return args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

main().catch((error) => {
  if (error instanceof LocalEnvError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
