import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const workflowUrl = new URL('../../.github/workflows/deploy-iwinv.yml', import.meta.url);
const workflow = await readFile(workflowUrl, 'utf8');

const requiredTriggerPredicates = [
  "needs.classify.outputs.is_production == 'true'",
  "github.repository == 'SeniorAILab/SeeON'",
];

const requiredDeliveryFragments = [
  'if [[ -z "$WEBHOOK_TOKEN" ]]',
  'WEBHOOK_TOKEN is required when deployment is enabled',
  'if [[ -z "$DEPLOY_WEBHOOK_URL" ]]',
  'DEPLOY_WEBHOOK_URL is required when deployment is enabled',
  'DEPLOY_WEBHOOK_URL: ${{ secrets.DEPLOY_WEBHOOK_URL }}',
  '--header "Authorization: Bearer $WEBHOOK_TOKEN"',
  '--data \'{}\'',
  '"$DEPLOY_WEBHOOK_URL"',
  '--connect-timeout 10',
  '--max-time 30',
  '--retry 0',
  '#587',
];

function requireFragment(source, fragment, label) {
  assert.ok(source.includes(fragment), `${label} is required`);
}

function extractJob(source, name, nextName) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `${name} job is required`);

  const end = nextName === undefined
    ? source.length
    : source.indexOf(`  ${nextName}:\n`, start);
  assert.notEqual(end, -1, `${nextName} job is required after ${name}`);

  return source.slice(start, end);
}

function extractRunScript(job, stepId) {
  const stepStart = job.indexOf(`      - id: ${stepId}\n`);
  assert.notEqual(stepStart, -1, `${stepId} step is required`);

  const step = job.slice(stepStart);
  const script = step.match(/        run: \|\n((?:          .*\n?)+)/)?.[1];
  assert.ok(script, `${stepId} shell script is required`);
  return script.replace(/^          /gm, '');
}

function assertWorkflowContract(source) {
  const onSection = source.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1];
  assert.ok(onSection, 'release trigger is required');
  assert.equal(
    onSection.trim(),
    'release:\n    types: [published]',
    'only release publication may trigger deployment',
  );
  assert.doesNotMatch(source, /workflow_run/, 'workflow_run must not trigger deployment');
  assert.doesNotMatch(
    source,
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    'workflow must not embed literal host addresses (deployment endpoint lives in the DEPLOY_WEBHOOK_URL secret)',
  );

  const classifyJob = extractJob(source, 'classify', 'trigger');
  requireFragment(
    classifyJob,
    'is_production: ${{ steps.classify.outputs.is_production }}',
    'classify output',
  );
  assert.doesNotMatch(classifyJob, /\bsecrets\.|WEBHOOK_TOKEN|GITHUB_TOKEN|github\.token/, 'classify must not access credentials');

  const classifierScript = extractRunScript(classifyJob, 'classify');
  requireFragment(
    classifierScript,
    '[[ "$IS_PRERELEASE" == "false" && "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]',
    'canonical production release classifier',
  );
  requireFragment(
    source,
    'cancel-in-progress: false',
    'non-cancelling deployment concurrency',
  );
  requireFragment(
    source,
    'group: deploy-iwinv-production-${{ github.event.release.tag_name }}',
    'tag-specific group so GitHub cannot replace another pending release signal',
  );
  requireFragment(
    source,
    '# A tag-specific group prevents GitHub\'s single pending-slot replacement from',
    'deployment concurrency rationale',
  );
  assert.doesNotMatch(source, /^\s*queue:/m, 'unsupported concurrency queue syntax must not be used');

  const triggerJob = extractJob(source, 'trigger');
  const gate = triggerJob.match(/if: >-\n([\s\S]*?)\n    runs-on:/)?.[1];
  assert.ok(gate, 'trigger job gate is required');
  for (const predicate of requiredTriggerPredicates) {
    requireFragment(gate, predicate, `trigger gate predicate ${predicate}`);
  }
  assert.ok(!workflow.includes('DEPLOY_ENABLED'), 'cutover interlock must stay removed');

  for (const fragment of requiredDeliveryFragments) {
    requireFragment(triggerJob, fragment, `delivery contract fragment ${fragment}`);
  }
  assert.equal([...triggerJob.matchAll(/--data\b/g)].length, 1, 'trigger must send one payload');
  assert.doesNotMatch(triggerJob, /\b(?:SHA|REF)\b|head_sha|refs\/heads|\bjq\b/, 'trigger payload must not contain SHA or ref data');

  const validationStep = triggerJob.match(
    /- name: Validate deployment webhook configuration\n([\s\S]*?)\n      - name: Trigger Jenkins deployment/,
  )?.[1];
  assert.ok(validationStep, 'unconditional webhook configuration validation step is required');
  assert.ok(!/^\s*if:/m.test(validationStep), 'webhook configuration validation must be unconditional');
  assert.match(validationStep, /set \+x/, 'webhook configuration validation must disable shell tracing');

  const triggerStep = triggerJob.match(/- name: Trigger Jenkins deployment\n([\s\S]*)$/)?.[1];
  assert.ok(triggerStep, 'Jenkins trigger step is required');
  assert.ok(!/^\s*if:/m.test(triggerStep), 'enabled deployment must not skip an empty token');
  assert.match(triggerStep, /set \+x/, 'Jenkins trigger must disable shell tracing');
  assert.doesNotMatch(triggerJob, /echo[^\n]*\$WEBHOOK_TOKEN/, 'workflow must never print WEBHOOK_TOKEN');

  return classifierScript;
}

async function classify(classifierScript, { tag, prerelease }) {
  const directory = await mkdtemp(join(tmpdir(), 'iwinv-workflow-contract-'));
  const output = join(directory, 'github-output');

  try {
    await execFileAsync('bash', ['-c', classifierScript], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        IS_PRERELEASE: String(prerelease),
        RELEASE_TAG: tag,
      },
    });
    return (await readFile(output, 'utf8')).trim();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('release publication deployment is gated before secrets are used', () => {
  assertWorkflowContract(workflow);
});

test('classifier accepts only non-prerelease strict semver release tags', async () => {
  const classifierScript = assertWorkflowContract(workflow);
  const cases = [
    { tag: 'v1.2.3', prerelease: false, expected: 'is_production=true' },
    { tag: 'v1.2.3-rc.1', prerelease: false, expected: 'is_production=false' },
    { tag: '1.2.3', prerelease: false, expected: 'is_production=false' },
    { tag: 'v1.2', prerelease: false, expected: 'is_production=false' },
    { tag: 'v1.2.3', prerelease: true, expected: 'is_production=false' },
    { tag: 'v01.2.3', prerelease: false, expected: 'is_production=false' },
  ];

  for (const testCase of cases) {
    assert.equal(await classify(classifierScript, testCase), testCase.expected, `${testCase.tag} prerelease=${testCase.prerelease}`);
  }
});
