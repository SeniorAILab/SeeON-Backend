import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../.github/workflows/deploy-iwinv.yml', import.meta.url);
const workflow = await readFile(workflowUrl, 'utf8');

const requiredGatePredicates = [
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.head_branch == 'main'",
  "github.event.workflow_run.event == 'push'",
  'github.event.workflow_run.head_repository.full_name == github.repository',
  "github.repository == 'SeniorAILab/eldercare-fall-ai'",
  "vars.DEPLOY_ENABLED == 'true'",
];

const requiredDeliveryFragments = [
  'if [[ -z "$WEBHOOK_TOKEN" ]]',
  'WEBHOOK_TOKEN is required when deployment is enabled',
  "payload=\"$(jq -nc --arg SHA \"$SHA\" '{workflow_run: {head_sha: $SHA, head_branch: \"main\", conclusion: \"success\"}, ref: \"refs/heads/main\"}')\"",
  '--header "Authorization: Bearer $WEBHOOK_TOKEN"',
  'http://<iwinv-host>/generic-webhook-trigger/invoke',
  '--connect-timeout 10',
  '--max-time 30',
  '--retry 0',
  '#587',
];

function requireFragment(source, fragment, label) {
  assert.ok(source.includes(fragment), `${label} is required`);
}

function assertWorkflowContract(source) {
  const gate = source.match(/if: >-\n([\s\S]*?)\n    runs-on:/)?.[1];
  assert.ok(gate, 'deployment job gate is required');
  for (const predicate of requiredGatePredicates) {
    requireFragment(gate, predicate, `provenance/disabled gate predicate ${predicate}`);
  }

  for (const fragment of requiredDeliveryFragments) {
    requireFragment(source, fragment, `delivery contract fragment ${fragment}`);
  }

  const validationStep = source.match(
    /- name: Validate deployment webhook token\n([\s\S]*?)\n      - name: Trigger Jenkins deployment/,
  )?.[1];
  assert.ok(validationStep, 'unconditional webhook token validation step is required');
  assert.ok(!/^\s*if:/m.test(validationStep), 'webhook token validation must be unconditional');
  const triggerStep = source.match(/- name: Trigger Jenkins deployment\n([\s\S]*?)\n(?:      - name:|$)/)?.[1];
  assert.ok(triggerStep, 'Jenkins trigger step is required');
  assert.ok(!/^\s*if:/m.test(triggerStep), 'enabled deployment must not skip an empty token');
  assert.ok(
    !/echo[^\n]*\$WEBHOOK_TOKEN/.test(source),
    'workflow must never print WEBHOOK_TOKEN',
  );
}

test('workflow_run deployment is provenance-gated before secrets are used', () => {
  assertWorkflowContract(workflow);
});

test('workflow contract rejects every required gate and delivery fragment when absent', () => {
  for (const fragment of [...requiredGatePredicates, ...requiredDeliveryFragments]) {
    assert.throws(
      () => assertWorkflowContract(workflow.replace(fragment, '')),
      /required/,
      `contract must reject absent fragment: ${fragment}`,
    );
  }
});
