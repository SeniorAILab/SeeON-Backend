import {
  type INestApplication,
  RequestMethod,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FacilityContextInterceptor } from '../src/auth/facility-context.interceptor.js';
import {
  JwtAuthGuard,
  RequireFacilityGuard,
} from '../src/auth/jwt-auth.guard.js';
import { CamerasService } from '../src/cameras/cameras.service.js';
import { EdgeIngestTokenGuard } from '../src/events/edge-ingest-token.guard.js';
import { EventAlarmService } from '../src/events/event-alarm.service.js';
import { EventRecorderService } from '../src/events/event-recorder.service.js';
import { EventsController } from '../src/events/events.controller.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { writeImmutableFile } from '../src/common/snapshot-storage.js';

const EDGE_TOKEN = 'event-snapshot-immutability-token';
const ROUTE_EVENT_ID = 'route-event-id';
const STORED_EVENT_ID = 'stored-event-id';
const FACILITY_ID = 'facility-owned-by-event';
const SNAPSHOT_KEY = `${FACILITY_ID}/${STORED_EVENT_ID}.jpg`;

describe('Event snapshot immutable HTTP contract', () => {
  let app: INestApplication<App>;
  let snapshotDir: string;
  const persistSnapshotKey = jest.fn<Promise<void>, [string, string, string]>();

  beforeEach(async () => {
    // Given: an event resolves to a server-owned facility and event id.
    snapshotDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'event-snapshot-immutable-'),
    );
    process.env.SNAPSHOT_DIR = snapshotDir;
    persistSnapshotKey.mockReset().mockResolvedValue(undefined);

    const moduleFixture = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        {
          provide: FacilityContextInterceptor,
          useValue: {
            intercept: (
              _context: unknown,
              next: { readonly handle: () => unknown },
            ) => next.handle(),
          },
        },
        {
          provide: JwtAuthGuard,
          useValue: { canActivate: jest.fn().mockReturnValue(true) },
        },
        {
          provide: RequireFacilityGuard,
          useValue: { canActivate: jest.fn().mockReturnValue(true) },
        },
        {
          provide: PrismaService,
          useValue: { withFacilityContext: jest.fn() },
        },
        EdgeIngestTokenGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({ EDGE_FACILITY_TOKEN: EDGE_TOKEN }),
        },
        {
          provide: EventRecorderService,
          useValue: {
            resolveForSnapshot: jest.fn().mockResolvedValue({
              id: STORED_EVENT_ID,
              facilityId: FACILITY_ID,
            }),
            persistSnapshotKey,
            list: jest.fn(),
          },
        },
        {
          provide: EventAlarmService,
          useValue: { record: jest.fn() },
        },
        {
          provide: CamerasService,
          useValue: {
            resolveForEventIngest: jest.fn(),
            recordHeartbeat: jest.fn(),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', {
      exclude: [{ path: '/', method: RequestMethod.ALL }],
    });
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SNAPSHOT_DIR;
    await fs.promises.rm(snapshotDir, { recursive: true, force: true });
  });

  it('returns 201 and stores bytes under event-derived ownership on first write', async () => {
    // Given: no snapshot exists for the resolved event.
    const original = Buffer.from('first-write');

    // When: the authenticated edge uploads the first snapshot.
    const response = await upload(original);

    // Then: the API creates the immutable object at its server-derived path.
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ snapshotKey: SNAPSHOT_KEY });
    await expect(fs.promises.readFile(snapshotPath())).resolves.toEqual(
      original,
    );
    expect(persistSnapshotKey).toHaveBeenCalledWith(
      FACILITY_ID,
      STORED_EVENT_ID,
      SNAPSHOT_KEY,
    );
  });

  it('returns 200 for a byte-identical sequential replay', async () => {
    // Given: the immutable snapshot already contains these exact bytes.
    const original = Buffer.from('identical-replay');
    await upload(original).then((response) =>
      expect(response.status).toBe(201),
    );

    // When: the edge retries the same bytes for the same event.
    const replay = await upload(original);

    // Then: the retry is acknowledged without replacing the object.
    expect(replay.status).toBe(200);
    await expect(fs.promises.readFile(snapshotPath())).resolves.toEqual(
      original,
    );
  });

  it('returns 409 and preserves original bytes for a conflicting sequential replay', async () => {
    // Given: an immutable snapshot has already been created.
    const original = Buffer.from('immutable-original');
    await upload(original).then((response) =>
      expect(response.status).toBe(201),
    );

    // When: a retry supplies different bytes for the same event.
    const conflict = await upload(Buffer.from('conflicting-replay'));

    // Then: the conflict is rejected and the original remains unchanged.
    expect(conflict.status).toBe(409);
    await expect(fs.promises.readFile(snapshotPath())).resolves.toEqual(
      original,
    );
  });

  it('returns one 201 and one 200 for concurrent byte-identical uploads', async () => {
    // Given: two workers hold the same snapshot and no object exists yet.
    const original = Buffer.from('concurrent-identical');

    // When: both workers upload concurrently.
    const responses = await Promise.all([upload(original), upload(original)]);

    // Then: one creates and the other idempotently replays the same object.
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 201]);
    await expect(fs.promises.readFile(snapshotPath())).resolves.toEqual(
      original,
    );
  });

  it('returns one 201 and one 409 for concurrent conflicting uploads without mixing bytes', async () => {
    // Given: two workers hold different snapshots and no object exists yet.
    const first = Buffer.from('concurrent-first');
    const second = Buffer.from('concurrent-second');

    // When: both workers upload concurrently.
    const [firstResponse, secondResponse] = await Promise.all([
      upload(first),
      upload(second),
    ]);

    // Then: exactly one complete input wins and the conflicting one is rejected.
    expect([firstResponse.status, secondResponse.status].sort()).toEqual([
      201, 409,
    ]);
    const stored = await fs.promises.readFile(snapshotPath());
    const winning = firstResponse.status === 201 ? first : second;
    expect(stored).toEqual(winning);
  });

  it('removes the candidate file when fsync fails without masking the error', async () => {
    // Given: the real candidate file opens and writes, but its fsync fails.
    const syncFailure = new Error('forced snapshot fsync failure');
    const openFile = fs.promises.open;
    const openSpy = jest
      .spyOn(fs.promises, 'open')
      .mockImplementationOnce(async (file, flags, mode) => {
        const handle = await openFile(file, flags, mode);
        jest.spyOn(handle, 'sync').mockRejectedValueOnce(syncFailure);
        return handle;
      });

    try {
      // When: immutable storage reaches the failed durability boundary.
      await expect(
        writeImmutableFile(
          path.join(snapshotDir, 'failed-sync.jpg'),
          Buffer.from('candidate-bytes'),
        ),
      ).rejects.toBe(syncFailure);
    } finally {
      openSpy.mockRestore();
    }

    // Then: the original sync error survives and no candidate file remains.
    await expect(fs.promises.readdir(snapshotDir)).resolves.toEqual([]);
  });

  function upload(body: Buffer) {
    return request(app.getHttpServer())
      .put(`/api/v1/events/${ROUTE_EVENT_ID}/snapshot`)
      .set('Authorization', `Bearer ${EDGE_TOKEN}`)
      .set('Content-Type', 'image/jpeg')
      .send(body);
  }

  function snapshotPath(): string {
    return path.join(snapshotDir, FACILITY_ID, `${STORED_EVENT_ID}.jpg`);
  }
});
