#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const usage = `Usage:
  pnpm release:prod -- vX.Y.Z [--target <ref>] [--title <title>] [--notes <notes>] [--dry-run]

Creates a non-prerelease GitHub Release. Publishing that release triggers the
Deploy Naver Cloud workflow.

Examples:
  pnpm release:prod -- v0.1.0
  pnpm release:prod -- v0.1.1 --target main --notes "Production deploy"
  pnpm release:prod -- v0.1.1 --dry-run
`;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    notes: undefined,
    target: "main",
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
    if (arg === "--target" || arg === "-t") {
      options.target = readValue(argv, index, arg);
      index += 1;
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
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(
      `Production release tag must use vMAJOR.MINOR.PATCH format, got "${tag}".`,
    );
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}.`);
  }
  return result;
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

  const title = options.title ?? tag;
  const notes = options.notes ?? `Production deploy ${tag}`;
  const ghArgs = [
    "release",
    "create",
    tag,
    "--target",
    options.target,
    "--title",
    title,
    "--notes",
    notes,
  ];

  if (options.dryRun) {
    process.stdout.write(`gh ${ghArgs.map(quoteShell).join(" ")}\n`);
    return;
  }

  run("gh", ["auth", "status"]);
  process.stdout.write(
    `Creating production release ${tag} targeting ${options.target}.\n`,
  );
  run("gh", ghArgs);
  process.stdout.write(
    [
      "Release created. GitHub Actions will run Deploy Naver Cloud from the release event.",
      "Watch it with:",
      `  gh run watch "$(gh run list --workflow "Deploy Naver Cloud" --limit 1 --json databaseId --jq '.[0].databaseId')"`,
      "",
    ].join("\n"),
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage}`);
  process.exit(1);
}
