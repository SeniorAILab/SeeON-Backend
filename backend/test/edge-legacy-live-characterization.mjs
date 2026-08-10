import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  characterizeLive,
  cleanupResources,
} from './helpers/edge-legacy-characterization.mjs';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const pinnedImageId =
  'sha256:57b4926af5f93763fb0cd19f64983542dffb0bf8bee71e61eaf3babe8ee104c8';
const rows = (table) => table.split('~').map((row) => row.split('|'));
const routeInventory = rows(
  'PUT /api/v1/edge/cameras|shared-edge-token + x-facility-id|client-header~POST /api/v1/events|shared-edge-token|camera-ownership~POST /api/v1/events/heartbeat|shared-edge-token|camera-ownership~PUT /api/v1/events/:eventId/snapshot|shared-edge-token|event-ownership; server-key~GET /api/v1/ml-config/:facilityId|shared-edge-token|path-facility~GET /api/v1/events/capabilities|shared-edge-token|camera-ownership~PUT /api/v1/events/clips/:clipId|shared-edge-token|camera-event-metadata~PUT /api/v1/events/clips/:clipId/state|shared-edge-token|camera-event-metadata',
);
const excludedRoutes = [
  'PUT /api/v1/ml-config/:facilityId/night-window',
  'GET|POST|PATCH|DELETE /api/v1/cameras',
];
const sourceRequirements = rows(
  String.raw`API_PREFIX|backend/src/main.ts|setGlobalPrefix\('api'~URI_VERSIONING|backend/src/main.ts|VersioningType\.URI~EDGE_CAMERA_GUARD|backend/src/cameras/cameras.controller.ts|UseGuards\(EdgeFacilityTokenGuard\)~EDGE_CAMERA_ROUTE|backend/src/cameras/cameras.controller.ts|@Put\(\)~EDGE_CAMERA_FACILITY_HEADER|backend/src/cameras/cameras.controller.ts|requireEdgeFacilityId~EVENTS_SHARED_GUARD|backend/src/events/events.controller.ts|UseGuards\(EdgeIngestTokenGuard\)~EVENT_ROUTES|backend/src/events/events.controller.ts|(?=.*@Post\(\))(?=.*@Post\('heartbeat'\))(?=.*@Put\(':eventId\/snapshot'\))|s~EVENT_CAMERA_OWNERSHIP|backend/src/events/events.controller.ts|resolveForEventIngest~SNAPSHOT_EVENT_OWNERSHIP|backend/src/events/events.controller.ts|resolveForSnapshot~SNAPSHOT_SERVER_KEY|backend/src/events/events.controller.ts|rejectClientSuppliedSnapshotKey~ML_CONFIG_SHARED_GUARD|backend/src/ml-config/ml-config.controller.ts|UseGuards\(EdgeIngestTokenGuard\)~ML_CONFIG_PATH_FACILITY|backend/src/ml-config/ml-config.controller.ts|@Get\(':facilityId'\)~CLIP_SHARED_GUARD|backend/src/media/edge-media.controller.ts|UseGuards\(EdgeIngestTokenGuard\)~CLIP_ROUTES|backend/src/media/edge-media.controller.ts|(?=.*@Get\('capabilities'\))(?=.*@Put\('clips\/:clipId'\))(?=.*@Put\('clips\/:clipId\/state'\))|s~CLIP_CAMERA_OWNERSHIP|backend/src/media/event-media.service.ts|resolveForEventIngest~EXCLUDED_ADMIN_NIGHT_WINDOW|backend/src/ml-config/ml-config.controller.ts|night-window~EXCLUDED_PRODUCT_CAMERAS|backend/src/cameras/cameras.controller.ts|UseGuards\(JwtAuthGuard, RequireFacilityGuard\)`,
).map(([code, file, expression, flags]) => [
  code,
  file,
  new RegExp(expression, flags),
]);

let interruptCleanup = async () => {};
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(
    signal,
    () => void interruptCleanup().finally(() => process.exit(130)),
  );

const parseArguments = (argumentsList) => {
  const result = { mode: 'source', image: pinnedImageId, valid: true };
  for (let index = 0; index < argumentsList.length; index += 2) {
    const [flag, value] = [argumentsList[index], argumentsList[index + 1]];
    if ((flag !== '--mode' && flag !== '--image') || value === undefined)
      return { ...result, valid: false };
    if (flag === '--mode') result.mode = value;
    if (flag === '--image') result.image = value;
  }
  return {
    ...result,
    valid:
      result.valid &&
      ['source', 'live'].includes(result.mode) &&
      result.image === pinnedImageId,
  };
};

const sourceCharacterization = async () => {
  const source = await Promise.all(
    sourceRequirements.map(async ([code, file, pattern]) => ({
      code,
      pass: pattern.test(await readFile(join(repositoryRoot, file), 'utf8')),
    })),
  );
  const files = [...new Set(sourceRequirements.map(([, file]) => file))];
  const sourceBytes = await Promise.all(
    files.map((file) => readFile(join(repositoryRoot, file))),
  );
  return {
    assertions: routeInventory.map(([routeTemplate, auth, facilitySource]) => ({
      routeTemplate,
      auth,
      facilitySource,
      expectedStatusClass: 'LIVE_REQUIRED',
      actualStatusClass: 'NOT_PROBED',
    })),
    excludedRoutes,
    sourceInventorySha256: createHash('sha256')
      .update(Buffer.concat(sourceBytes))
      .digest('hex'),
    mismatchCodes: source
      .filter(({ pass }) => !pass)
      .map(({ code }) => `SOURCE_${code}`),
  };
};

const sourceSha = () => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'UNAVAILABLE';
};

const run = async () => {
  const argumentsResult = parseArguments(process.argv.slice(2));
  const cleanup = {
    tempDir: await mkdtemp(join(tmpdir(), 'edge-characterization-')),
  };
  interruptCleanup = async () => cleanupResources(cleanup);
  let source = {
    assertions: [],
    excludedRoutes,
    sourceInventorySha256: 'UNAVAILABLE',
    mismatchCodes: ['SOURCE_READ_FAILURE'],
  };
  let live = {
    status: 'SOURCE_CHARACTERIZED',
    imageHash: argumentsResult.image,
    assertions: [],
  };
  let mismatchCodes = [];
  try {
    source = await sourceCharacterization();
    mismatchCodes = [...source.mismatchCodes];
    if (!argumentsResult.valid) mismatchCodes.push('ARGUMENT_INVALID');
    else if (argumentsResult.mode === 'live')
      live = await characterizeLive(argumentsResult.image, cleanup);
    if (live.deploySha !== undefined && live.deploySha !== sourceSha())
      mismatchCodes.push('IMAGE_SOURCE_SHA_MISMATCH');
    for (const assertion of live.assertions)
      if (assertion.expectedStatusClass !== assertion.actualStatusClass)
        mismatchCodes.push(
          `LIVE_${assertion.routeTemplate.replaceAll('/', '_')}_STATUS_MISMATCH`,
        );
  } catch {
    mismatchCodes.push('HARNESS_FAILURE');
    live = {
      status: 'HARNESS_FAILURE',
      imageHash: argumentsResult.image,
      assertions: [],
    };
  } finally {
    const result = {
      mode: argumentsResult.mode,
      result: live.status,
      sourceSha: sourceSha(),
      imageHash: live.imageHash,
      sourceInventorySha256: source.sourceInventorySha256,
      sourceAssertions: source.assertions,
      liveAssertions: live.assertions,
      excludedRoutes: source.excludedRoutes,
      mismatchCodes: [...new Set(mismatchCodes)],
      cleanup: await cleanupResources(cleanup),
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.mismatchCodes.length === 0 ? 0 : 2;
  }
};

run().catch(() => {
  process.stdout.write(
    '{"result":"HARNESS_FAILURE","mismatchCodes":["HARNESS_FAILURE"]}\n',
  );
  process.exitCode = 2;
});
