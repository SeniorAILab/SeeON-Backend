import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const rows = (table) => table.split('~').map((row) => row.split('|'));
const command = (program, argumentsList) => {
  const result = spawnSync(program, argumentsList, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  return {
    ok: result.status === 0 && result.error === undefined,
    output: result.stdout.trim(),
  };
};
const docker = (text) => command('docker', text.split(' '));
const pause = () => new Promise((resume) => setTimeout(resume, 500));
const blocked = (imageHash) => ({
  status: 'BLOCKED_LIVE',
  imageHash,
  assertions: [],
});
const statusClass = (status) =>
  ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'][status - 400] ??
  `${Math.floor(status / 100)}XX`;
const localCredentials = () => {
  const value = () => randomUUID().replaceAll('-', '');
  return {
    edgeToken: value(),
    databasePassword: value(),
    sessionSecret: value(),
  };
};

const probe = async (baseUrl, definition) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const assertion = {
    routeTemplate: definition.routeTemplate,
    auth: definition.auth,
    facilitySource: definition.facilitySource,
    expectedStatusClass: definition.expected,
  };
  try {
    const response = await fetch(`${baseUrl}${definition.path}`, {
      method: definition.method,
      headers: definition.headers,
      body: definition.body,
      signal: controller.signal,
    });
    return { ...assertion, actualStatusClass: statusClass(response.status) };
  } catch {
    return { ...assertion, actualStatusClass: 'TRANSPORT_FAILURE' };
  } finally {
    clearTimeout(timer);
  }
};

const probeDefinitions = (edgeToken) => {
  const headers = (kind) => {
    const authenticated = {
      authorization: `Bearer ${edgeToken}`,
      'content-type': 'application/json',
    };
    if (kind === 'none') return { 'content-type': 'application/json' };
    if (kind === 'facility')
      return { ...authenticated, 'x-facility-id': 'characterization-facility' };
    return kind === 'snapshot'
      ? { ...authenticated, 'x-snapshot-key': 'rejected' }
      : authenticated;
  };
  const camera = 'characterization-unknown-camera';
  const bodies = {
    empty: undefined,
    json: '{}',
    heartbeat: JSON.stringify({ camera_id: camera }),
    snapshot: 'x',
  };
  return rows(
    'PUT|/api/v1/edge/cameras|none|empty|UNAUTHORIZED|shared-edge-token + x-facility-id|client-header~PUT|/api/v1/edge/cameras|auth|json|FORBIDDEN|shared-edge-token + x-facility-id|client-header~PUT|/api/v1/edge/cameras|facility|json|BAD_REQUEST|shared-edge-token + x-facility-id|client-header~POST|/api/v1/events|none|json|UNAUTHORIZED|shared-edge-token|camera-ownership~POST|/api/v1/events/heartbeat|auth|heartbeat|NOT_FOUND|shared-edge-token|camera-ownership~PUT|/api/v1/events/characterization-event/snapshot|none|snapshot|UNAUTHORIZED|shared-edge-token|event-ownership; server-key~PUT|/api/v1/events/characterization-event/snapshot|snapshot|snapshot|BAD_REQUEST|shared-edge-token|event-ownership; server-key~GET|/api/v1/ml-config/characterization-facility|none|empty|UNAUTHORIZED|shared-edge-token|path-facility~GET|/api/v1/events/capabilities?camera_id=%camera%|none|empty|UNAUTHORIZED|shared-edge-token|camera-ownership~GET|/api/v1/events/capabilities?camera_id=%camera%|auth|empty|NOT_FOUND|shared-edge-token|camera-ownership~PUT|/api/v1/events/clips/characterization-clip|none|empty|UNAUTHORIZED|shared-edge-token|camera-event-metadata~PUT|/api/v1/events/clips/characterization-clip/state|none|json|UNAUTHORIZED|shared-edge-token|camera-event-metadata',
  ).map(
    ([method, rawPath, authKind, bodyKind, expected, auth, facilitySource]) => {
      const path = rawPath.replace('%camera%', camera);
      return {
        method,
        path,
        headers: headers(authKind),
        body: bodies[bodyKind],
        expected,
        auth,
        facilitySource,
        routeTemplate: path
          .replace('characterization-event', ':eventId')
          .replace('characterization-clip', ':clipId')
          .replace(/\?camera_id=.*/, ''),
      };
    },
  );
};

export const characterizeLive = async (imageId, cleanup) => {
  if (
    !docker(`image inspect ${imageId}`).ok ||
    !docker('image inspect postgres:17-alpine').ok
  )
    return blocked(imageId);
  const deploySha = JSON.parse(docker(`image inspect ${imageId}`).output)[0]
    ?.Config?.Env?.find((entry) => entry.startsWith('DEPLOY_SHA='))
    ?.slice(11);
  const credentials = localCredentials();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const resources = Object.fromEntries(
    ['network', 'db', 'app'].map((kind) => [
      kind,
      `characterization-${kind}-${suffix}`,
    ]),
  );
  const databaseUrl = `postgresql://characterization:${credentials.databasePassword}@characterization-db:5432/characterization?schema=public`;
  const environmentFile = join(cleanup.tempDir, 'live.env');
  await writeFile(
    environmentFile,
    `POSTGRES_USER=characterization|POSTGRES_PASSWORD=${credentials.databasePassword}|POSTGRES_DB=characterization|DATABASE_URL=${databaseUrl}|DIRECT_URL=${databaseUrl}|EDGE_FACILITY_TOKEN=${credentials.edgeToken}|SESSION_JWT_SECRET=${credentials.sessionSecret}|FRONT_ORIGIN=http://127.0.0.1|EVENT_CLIPS_ENABLED=false|MEDIA_CLIP_DIR=/tmp/clips`.replaceAll(
      '|',
      '\n',
    ),
    { mode: 0o600 },
  );
  const actions = [
    ['network', `network create --internal ${resources.network}`],
    [
      'db',
      `run -d --name ${resources.db} --network ${resources.network} --network-alias characterization-db --env-file ${environmentFile} postgres:17-alpine`,
    ],
    [
      'migrate',
      `run --rm --network ${resources.network} --env-file ${environmentFile} ${imageId} node node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma`,
    ],
    [
      'app',
      `run -d --name ${resources.app} --network ${resources.network} --read-only --tmpfs /tmp -p 127.0.0.1::8080 --env-file ${environmentFile} ${imageId}`,
    ],
  ];
  for (const [key, text] of actions) {
    if (key === 'migrate')
      for (
        let attempt = 0;
        attempt < 20 &&
        !docker(
          `exec ${resources.db} pg_isready -U characterization -d characterization`,
        ).ok;
        attempt += 1
      )
        await pause();
    if (!docker(text).ok) return blocked(imageId);
    if (key !== 'migrate') cleanup[key] = resources[key];
  }
  const port = docker(`port ${resources.app} 8080/tcp`);
  const match = port.output.match(/:(\d+)$/m);
  if (!port.ok || match === null) return blocked(imageId);
  const baseUrl = `http://127.0.0.1:${match[1]}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) })
        .then((response) => response.ok)
        .catch(() => false)
    )
      break;
    await pause();
  }
  const assertions = await Promise.all(
    probeDefinitions(credentials.edgeToken).map((definition) =>
      probe(baseUrl, definition),
    ),
  );
  return {
    status: 'LIVE_CHARACTERIZED',
    imageHash: imageId,
    deploySha,
    assertions,
  };
};

export const cleanupResources = async (cleanup) => {
  const receipt = { containers: true, network: true, tempDir: true };
  for (const resource of [cleanup.app, cleanup.db])
    if (resource !== undefined)
      receipt.containers &&= docker(`rm -f ${resource}`).ok;
  if (cleanup.network !== undefined)
    receipt.network = docker(`network rm ${cleanup.network}`).ok;
  if (cleanup.tempDir !== undefined)
    await rm(cleanup.tempDir, { recursive: true, force: true });
  return receipt;
};
