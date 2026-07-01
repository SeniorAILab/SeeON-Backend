#!/usr/bin/env node
import {
  assertNoUnknownArgs,
  LocalEnvError,
  loadAndValidateLocalEnv,
  parseCommonArgs,
  printLocalEnvSummary,
} from './local-env.mjs';

async function main() {
  const { envFile, rest } = parseCommonArgs(process.argv.slice(2));
  assertNoUnknownArgs(rest);
  const { summary } = await loadAndValidateLocalEnv(envFile);
  printLocalEnvSummary(summary);
}

main().catch((error) => {
  if (error instanceof LocalEnvError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
