#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST = /^.+@sha256:[a-f0-9]{64}$/;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\beft_v1\.[A-Z0-9]{12}\.[A-Za-z0-9_-]{20,}\b/,
  /\brtsp:\/\/[^\s<]+/,
  /\b(?:password|token|secret)\s*[=:]\s*(?!<redacted>|redacted|not-in-fixture)["']?[^\s"']{12,}/i,
];

class EvidenceError extends Error {}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--fixture') return { fixture: true };
  const values = { fixture: false, seal: '' };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new EvidenceError(`missing value for ${flag}`);
    if (flag === '--plan') values.plan = value;
    else if (flag === '--plan-sha256') values.planSha256 = value;
    else if (flag === '--evidence') values.evidence = value;
    else if (flag === '--ai') values.ai = value;
    else if (flag === '--ml') values.ml = value;
    else if (flag === '--seal') values.seal = value;
    else throw new EvidenceError(`unknown argument: ${flag}`);
  }
  for (const key of ['plan', 'planSha256', 'evidence', 'ai', 'ml']) {
    if (!values[key]) throw new EvidenceError(`missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return values;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new EvidenceError(`${label} is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

function validateSeal(seal, planSha256) {
  if (seal.schemaVersion !== 1) throw new EvidenceError('seal schemaVersion must be 1');
  if (seal.approvedPlanSha256 !== planSha256) throw new EvidenceError('seal approved-plan binding mismatch');
  for (const [name, record] of Object.entries({ ai: seal.ai, ml: seal.ml })) {
    if (!record || typeof record !== 'object') throw new EvidenceError(`seal ${name} record is missing`);
    if (!GIT_SHA.test(record.sha ?? '')) throw new EvidenceError(`seal ${name} SHA is invalid`);
  }
  for (const [label, image] of [
    ['AI backend', seal.ai.backendImage], ['AI front', seal.ai.frontImage],
    ['ML API', seal.ml.apiImage], ['ML worker', seal.ml.workerImage],
  ]) {
    if (!IMAGE_DIGEST.test(image ?? '')) throw new EvidenceError(`${label} image is not digest-pinned`);
  }
}

function assertRedacted(path) {
  const text = readFileSync(path, 'utf8');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new EvidenceError(`secret-shaped content in ${path}`);
  }
}

function gitHead(path) {
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'edge-evidence-fixture-'));
  try {
    const plan = join(root, 'plan.md');
    const evidence = join(root, 'evidence');
    mkdirSync(evidence);
    writeFileSync(plan, 'approved fixture plan\n');
    const planDigest = sha256(plan);
    const seal = {
      schemaVersion: 1,
      approvedPlanSha256: planDigest,
      ai: {
        sha: 'a'.repeat(40),
        backendImage: `local/backend@sha256:${'b'.repeat(64)}`,
        frontImage: `local/front@sha256:${'c'.repeat(64)}`,
      },
      ml: {
        sha: 'd'.repeat(40),
        apiImage: `local/api@sha256:${'e'.repeat(64)}`,
        workerImage: `local/worker@sha256:${'f'.repeat(64)}`,
      },
    };
    validateSeal(seal, planDigest);
    writeFileSync(join(evidence, 'safe.txt'), 'token=<redacted>\n');
    assertRedacted(join(evidence, 'safe.txt'));
    for (const invalid of [
      { ...seal, approvedPlanSha256: '0'.repeat(64) },
      { ...seal, ai: { ...seal.ai, sha: 'short' } },
      { ...seal, ml: { ...seal.ml, workerImage: 'mutable:latest' } },
    ]) {
      let rejected = false;
      try { validateSeal(invalid, planDigest); } catch (error) {
        if (!(error instanceof EvidenceError)) throw error;
        rejected = true;
      }
      if (!rejected) throw new EvidenceError('invalid seal fixture passed');
    }
    writeFileSync(join(evidence, 'leak.txt'), `token=${'x'.repeat(24)}\n`);
    let leakRejected = false;
    try { assertRedacted(join(evidence, 'leak.txt')); } catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      leakRejected = true;
    }
    if (!leakRejected) throw new EvidenceError('secret fixture passed');
    console.log('EDGE_PROVISIONING_EVIDENCE_FIXTURE_OK');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function verify(options) {
  const plan = resolve(options.plan);
  const evidence = resolve(options.evidence);
  const ai = resolve(options.ai);
  const ml = resolve(options.ml);
  if (!SHA256.test(options.planSha256)) throw new EvidenceError('approved plan SHA-256 is invalid');
  if (sha256(plan) !== options.planSha256) throw new EvidenceError('approved plan content changed');
  const sealPath = resolve(options.seal || join(evidence, 'final-rc-seal.json'));
  const seal = readJson(sealPath, 'final RC seal');
  validateSeal(seal, options.planSha256);
  if (gitHead(ai) !== seal.ai.sha) throw new EvidenceError('AI worktree is not at sealed SHA');
  if (gitHead(ml) !== seal.ml.sha) throw new EvidenceError('ML worktree is not at sealed SHA');
  for (let task = 1; task <= 20; task += 1) {
    const path = join(evidence, `task-${task}-edge-driven-facility-provisioning.txt`);
    assertRedacted(path);
  }
  const aiFixture = readJson(join(ai, 'backend/test/fixtures/edge-provisioning-v1/contract-fixtures.json'), 'AI contract fixture');
  const mlFixture = readJson(join(ml, 'contracts/edge-provisioning-v1/contract-fixtures.json'), 'ML contract fixture');
  const aiDigest = aiFixture.metadata?.canonicalSha256;
  const mlDigest = mlFixture.metadata?.canonicalSha256;
  if (!SHA256.test(aiDigest ?? '') || aiDigest !== mlDigest) throw new EvidenceError('cross-repository contract digest mismatch');
  assertRedacted(sealPath);
  console.log(`PLAN_COMPLIANCE_OK ai_sha=${seal.ai.sha} ml_sha=${seal.ml.sha}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.fixture) fixture();
  else verify(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'evidence verification failed');
  process.exitCode = 1;
}
