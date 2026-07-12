#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const usage = `Usage:
  pnpm release:prod -- vX.Y.Z [--title <title>] [--notes <notes>] [--dry-run]

Creates a non-prerelease GitHub Release from main. Publishing the release starts
the production deployment.

Examples:
  pnpm release:prod -- v0.1.0
  pnpm release:prod -- v0.1.1 --notes "Production release"
  pnpm release:prod -- v0.1.1 --dry-run
`;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    notes: undefined,
    title: undefined,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, options, tag: undefined };
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--title") {
      options.title = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--notes" || arg === "-n") {
      options.notes = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length !== 1) {
    throw new Error("Exactly one release tag is required.");
  }

  return { help: false, options, tag: positionals[0] };
}

function readValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function validateTag(tag) {
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag)) {
    throw new Error(
      `Production release tag must use vMAJOR.MINOR.PATCH format, got "${tag}".`,
    );
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}.`);
  }
}

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function main() {
  const { help, options, tag } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(usage);
    return;
  }

  validateTag(tag);

  const ghArgs = [
    "release",
    "create",
    tag,
    "--target",
    "main",
    "--title",
    options.title ?? tag,
  ];
  if (options.notes === undefined) {
    ghArgs.push("--generate-notes");
  } else {
    ghArgs.push("--notes", options.notes);
  }

  if (options.dryRun) {
    process.stdout.write(`gh ${ghArgs.map(quoteShell).join(" ")}\n`);
    return;
  }

  run("gh", ["auth", "status"]);
  process.stdout.write(`Creating production release ${tag} targeting main.\n`);
  run("gh", ghArgs);
  process.stdout.write(
    `Release created. Publishing this release starts automatic production deployment.\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage}`);
  process.exit(1);
}
