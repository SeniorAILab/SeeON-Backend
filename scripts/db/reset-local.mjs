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
} from '../dev/local-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const backendDir = resolve(repoRoot, 'backend');

async function main() {
  const { dryRun, envFile, rest } = parseCommonArgs(process.argv.slice(2));
  assertNoUnknownArgs(rest);
  const { env, summary } = await loadAndValidateLocalEnv(envFile);
  printLocalEnvSummary(summary);

  const childEnv = { ...process.env, ...env };
  const steps = [
    {
      label: 'prisma:migrate reset',
      args: [
        'exec',
        'prisma',
        'migrate',
        'reset',
        '--force',
        '--skip-generate',
        '--skip-seed',
      ],
      cwd: backendDir,
    },
    {
      label: 'prisma:generate',
      args: ['exec', 'prisma', 'generate'],
      cwd: backendDir,
    },
    {
      label: 'prisma:seed',
      args: ['exec', 'ts-node', 'prisma/seed.ts'],
      cwd: backendDir,
    },
    {
      label: 'prisma:seed-super-admin',
      args: ['exec', 'ts-node', 'prisma/seed-super-admin.ts'],
      cwd: backendDir,
    },
  ];

  for (const step of steps) {
    await runPnpmStep(step, childEnv, dryRun);
  }
}

function runPnpmStep(step, env, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] ${step.label} -> pnpm ${quoteArgs(step.args)}`);
    return Promise.resolve();
  }

  return new Promise((resolveStep, reject) => {
    const child = spawn('pnpm', step.args, {
      cwd: step.cwd,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveStep();
        return;
      }
      reject(
        new Error(
          `${step.label} failed with ${signal ? `signal ${signal}` : `exit ${code}`}`,
        ),
      );
    });
  });
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
