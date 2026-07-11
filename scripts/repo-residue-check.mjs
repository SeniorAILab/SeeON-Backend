#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

const ignoredDirectories = new Set(['.git', '.venv', 'node_modules']);
const selfPaths = new Set([
  'scripts/repo-residue-check.mjs',
  'scripts/repo-residue-check.test.mjs',
]);

function parseArgs(argv) {
  const options = { allow: new Map(), repoRole: undefined, root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo-role') {
      options.repoRole = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--root') {
      options.root = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--allow') {
      const value = requireValue(argv, index, arg);
      const separator = value.indexOf(':');
      if (separator <= 0 || value.slice(separator + 1).trim().length === 0) {
        throw new Error('--allow requires <path>:<reason>.');
      }
      options.allow.set(normalizePath(value.slice(0, separator)), value.slice(separator + 1).trim());
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.repoRole !== 'host' && options.repoRole !== 'ml') {
    throw new Error('--repo-role must be host or ml.');
  }
  return options;
}

function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function normalizePath(path) {
  return path.split(sep).join('/').replace(/^\.\//, '').replace(/\/$/, '');
}

function isRuntimeEnv(path) {
  return (path === '.env' || path.startsWith('.env.')) && !path.endsWith('.example');
}

function collectFiles(root, directory = root, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    const path = normalizePath(relative(root, absolute));
    if (entry.isDirectory()) {
      collectFiles(root, absolute, files);
    } else if (entry.isFile() && !isRuntimeEnv(path)) {
      files.push(path);
    }
  }
  return files;
}

function fileText(root, path) {
  try {
    return readFileSync(resolve(root, path), 'utf8');
  } catch {
    return '';
  }
}

function violation(path, message) {
  return { message, path };
}

function hasPath(root, path) {
  return existsSync(resolve(root, path));
}

function hostViolations(root, files) {
  const violations = [];
  for (const path of ['ml', 'compose.edge.yaml']) {
    if (hasPath(root, path)) violations.push(violation(path, 'host repository retains an ML runtime path'));
  }

  const oldNamespace = /ghcr\.io\/seniorailab\/eldercare-fall-ai\/ml-(api|worker)/i;
  const newNamespace = /ghcr\.io\/seniorailab\/eldercare-fall-ml\/ml-(api|worker)/i;
  for (const path of files) {
    if (selfPaths.has(path)) continue;
    const text = fileText(root, path);
    if (oldNamespace.test(text) || newNamespace.test(text)) {
      violations.push(violation(path, 'host repository references an ML GHCR namespace'));
    }
  }

  for (const path of files.filter((file) => file.startsWith('scripts/release/') && file.endsWith('.mjs'))) {
    const text = fileText(root, path);
    if (/ml\/Dockerfile\.(api|worker)/i.test(text) || /Build and push ml-(api|worker) image/i.test(text)) {
      violations.push(violation(path, 'release entrypoint builds an ML image'));
    }
    if (/four[^\n]{0,100}same-SHA/i.test(text) || (/\b4-image\b/i.test(text) && /ml-(api|worker)/i.test(text))) {
      violations.push(violation(path, 'release entrypoint retains four-image ML release semantics'));
    }
  }
  return violations;
}

function mlViolations(root, files) {
  const violations = [];
  const requiredPaths = [
    'compose.edge.yaml',
    'Dockerfile.api',
    'Dockerfile.worker',
    'worker',
    'api',
    'contracts',
    'scripts/edge-updater',
    '.github/workflows/edge-images.yml',
  ];
  for (const path of requiredPaths) {
    if (!hasPath(root, path)) violations.push(violation(path, 'ML repository is missing a required edge-runtime path'));
  }
  if (hasPath(root, 'ml')) violations.push(violation('ml', 'ML repository retains the old ml/ prefix'));

  const oldNamespace = /ghcr\.io\/seniorailab\/eldercare-fall-ai\/ml-(api|worker)/i;
  const hostCoupling = /ncloud-deploy|deploy:prod:manual|compose\.prod\.yaml|scripts\/deploy\/ncloud|scripts\/release\/manual-production/i;
  for (const path of files) {
    if (selfPaths.has(path)) continue;
    const text = fileText(root, path);
    if (oldNamespace.test(text)) violations.push(violation(path, 'ML repository references the old monorepo GHCR namespace'));
    if (hostCoupling.test(text)) violations.push(violation(path, 'ML repository is coupled to host deployment'));
  }
  return violations;
}

function run(options) {
  const root = resolve(options.root);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`Repository root does not exist: ${root}`);
  const files = collectFiles(root);
  const violations = options.repoRole === 'host' ? hostViolations(root, files) : mlViolations(root, files);
  const blocked = violations.filter(({ path }) => !options.allow.has(path));
  return { allowed: violations.length - blocked.length, blocked, scanned: files.length };
}

function printUsage() {
  process.stdout.write('Usage: node scripts/repo-residue-check.mjs --repo-role host|ml [--root <path>] [--allow <path>:<reason>]\n');
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
  } else {
    const result = run(options);
    if (result.blocked.length > 0) {
      for (const { path, message } of result.blocked) process.stderr.write(`${path}: ${message}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`repository residue check passed: role=${options.repoRole} scanned=${result.scanned} allowed=${result.allowed}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
