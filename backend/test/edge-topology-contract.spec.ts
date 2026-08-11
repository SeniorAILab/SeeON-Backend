import { EdgeTopologyHarness } from './helpers/edge-topology-harness.js';
import { registerTopologyLifecycleTests } from './helpers/edge-topology-lifecycle-scenarios.js';
import { registerTopologySnapshotTests } from './helpers/edge-topology-snapshot-scenarios.js';

describe('edge topology snapshot v1 contract', () => {
  const harness = new EdgeTopologyHarness();

  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterAll(() => harness.stop());

  registerTopologySnapshotTests(harness);
  registerTopologyLifecycleTests(harness);
});
