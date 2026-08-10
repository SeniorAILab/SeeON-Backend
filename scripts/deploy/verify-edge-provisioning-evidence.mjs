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
  const values = { fixture: false, seal: '', sealSha256: '' };
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
    else if (flag === '--seal-sha256') values.sealSha256 = value;
    else throw new EvidenceError(`unknown argument: ${flag}`);
  }
  for (const key of ['plan', 'planSha256', 'evidence', 'ai', 'ml', 'sealSha256']) {
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
  if (seal.schemaVersion !== 2) throw new EvidenceError('seal schemaVersion must be 2');
  if (seal.approvedPlanSha256 !== planSha256) throw new EvidenceError('seal approved-plan binding mismatch');
  for (const [name, record, repository] of [
    ['ai', seal.ai, 'SeniorAILab/eldercare-fall-ai'],
    ['ml', seal.ml, 'SeniorAILab/eldercare-fall-ml-v2'],
  ]) {
    if (!record || typeof record !== 'object') throw new EvidenceError(`seal ${name} record is missing`);
    if (!GIT_SHA.test(record.sha ?? '')) throw new EvidenceError(`seal ${name} SHA is invalid`);
    if (!GIT_SHA.test(record.tree ?? '')) throw new EvidenceError(`seal ${name} tree is invalid`);
    if (record.repository !== repository) throw new EvidenceError(`seal ${name} repository identity is invalid`);
  }
  for (const [label, image, revision, repository] of [
    ['AI backend', seal.ai.backendImage, seal.ai.sha, seal.ai.repository],
    ['AI front', seal.ai.frontImage, seal.ai.sha, seal.ai.repository],
    ['ML API', seal.ml.apiImage, seal.ml.sha, seal.ml.repository],
    ['ML worker', seal.ml.workerImage, seal.ml.sha, seal.ml.repository],
  ]) {
    if (!image || typeof image !== 'object') throw new EvidenceError(`${label} image record is missing`);
    if (!IMAGE_DIGEST.test(image.ref ?? '')) throw new EvidenceError(`${label} image is not digest-pinned`);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.imageId ?? '')) throw new EvidenceError(`${label} image ID is invalid`);
    if (!/^linux\/(?:amd64|arm64)$/.test(image.platform ?? '')) throw new EvidenceError(`${label} platform is invalid`);
    if (image.revision !== revision || image.repository !== repository) throw new EvidenceError(`${label} source provenance mismatch`);
  }
}

function repositoryIdentity(path) {
  const remote = execFileSync('git', ['-C', path, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const match = remote.match(/SeniorAILab\/(eldercare-fall-(?:ai|ml-v2))(?:\.git)?$/);
  if (!match) throw new EvidenceError(`unrecognized repository origin: ${remote}`);
  return `SeniorAILab/${match[1]}`;
}

function verifyRepository(path, record, label) {
  execFileSync('git', ['-C', path, 'cat-file', '-e', `${record.sha}^{commit}`]);
  if (gitHead(path) !== record.sha) throw new EvidenceError(`${label} worktree is not at sealed SHA`);
  const tree = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  if (tree !== record.tree) throw new EvidenceError(`${label} commit tree mismatch`);
  if (repositoryIdentity(path) !== record.repository) throw new EvidenceError(`${label} repository origin mismatch`);
}

function verifyImage(image, label) {
  const raw = execFileSync('docker', ['image', 'inspect', image.ref], { encoding: 'utf8' });
  const [inspected] = JSON.parse(raw);
  if (!inspected || inspected.Id !== image.imageId) throw new EvidenceError(`${label} image ID mismatch`);
  if (`${inspected.Os}/${inspected.Architecture}` !== image.platform) throw new EvidenceError(`${label} platform mismatch`);
  const labels = inspected.Config?.Labels ?? {};
  if (labels['org.opencontainers.image.revision'] !== image.revision) throw new EvidenceError(`${label} revision label mismatch`);
  if (labels['org.opencontainers.image.source'] !== image.repository) throw new EvidenceError(`${label} source label mismatch`);
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
      schemaVersion: 2,
      approvedPlanSha256: planDigest,
      ai: {
        repository: 'SeniorAILab/eldercare-fall-ai',
        sha: 'a'.repeat(40),
        tree: '1'.repeat(40),
        backendImage: { ref: `local/backend@sha256:${'b'.repeat(64)}`, imageId: `sha256:${'3'.repeat(64)}`, platform: 'linux/arm64', revision: 'a'.repeat(40), repository: 'SeniorAILab/eldercare-fall-ai' },
        frontImage: { ref: `local/front@sha256:${'c'.repeat(64)}`, imageId: `sha256:${'4'.repeat(64)}`, platform: 'linux/arm64', revision: 'a'.repeat(40), repository: 'SeniorAILab/eldercare-fall-ai' },
      },
      ml: {
        repository: 'SeniorAILab/eldercare-fall-ml-v2',
        sha: 'd'.repeat(40),
        tree: '2'.repeat(40),
        apiImage: { ref: `local/api@sha256:${'e'.repeat(64)}`, imageId: `sha256:${'5'.repeat(64)}`, platform: 'linux/arm64', revision: 'd'.repeat(40), repository: 'SeniorAILab/eldercare-fall-ml-v2' },
        workerImage: { ref: `local/worker@sha256:${'f'.repeat(64)}`, imageId: `sha256:${'6'.repeat(64)}`, platform: 'linux/amd64', revision: 'd'.repeat(40), repository: 'SeniorAILab/eldercare-fall-ml-v2' },
      },
    };
    validateSeal(seal, planDigest);
    writeFileSync(join(evidence, 'safe.txt'), 'token=<redacted>\n');
    assertRedacted(join(evidence, 'safe.txt'));
    for (const invalid of [
      { ...seal, approvedPlanSha256: '0'.repeat(64) },
      { ...seal, ai: { ...seal.ai, sha: 'short' } },
      { ...seal, ml: { ...seal.ml, workerImage: { ...seal.ml.workerImage, ref: 'mutable:latest' } } },
      { ...seal, ai: { ...seal.ai, repository: 'attacker/repository' } },
      { ...seal, ml: { ...seal.ml, apiImage: { ...seal.ml.apiImage, revision: '0'.repeat(40) } } },
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
  if (!SHA256.test(options.sealSha256)) throw new EvidenceError('sealed RC SHA-256 anchor is invalid');
  if (sha256(plan) !== options.planSha256) throw new EvidenceError('approved plan content changed');
  const sealPath = resolve(options.seal || join(evidence, 'final-rc-seal.json'));
  if (sha256(sealPath) !== options.sealSha256) throw new EvidenceError('sealed RC content-address mismatch');
  const seal = readJson(sealPath, 'final RC seal');
  validateSeal(seal, options.planSha256);
  verifyRepository(ai, seal.ai, 'AI');
  verifyRepository(ml, seal.ml, 'ML');
  verifyImage(seal.ai.backendImage, 'AI backend');
  verifyImage(seal.ai.frontImage, 'AI front');
  verifyImage(seal.ml.apiImage, 'ML API');
  verifyImage(seal.ml.workerImage, 'ML worker');
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
