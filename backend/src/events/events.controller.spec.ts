import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { EventsController } from './events.controller.js';
import { EdgeIngestTokenGuard } from './edge-ingest-token.guard.js';
import type { EventAlarmService } from './event-alarm.service.js';
import type { EventRecorderService } from './event-recorder.service.js';
import type { CamerasService } from '../cameras/cameras.service.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type RecordedEventResponse = {
  readonly event: { readonly id: string };
  readonly duplicate: boolean;
};

function recordEventMock(): jest.Mock<
  Promise<RecordedEventResponse>,
  [unknown]
> {
  return jest.fn<Promise<RecordedEventResponse>, [unknown]>();
}

function edgeRequest(principal?: {
  facilityId?: string;
  validationRunId?: string;
}) {
  return { edgePrincipal: principal } as never;
}

describe('EventsController record', () => {
  // Event-type canonicalization (trim+lowercase) and enum-membership
  // rejection now live entirely in EventRecorderService.record() (see
  // event-recorder.service.spec.ts's "rejects unknown event types before
  // writing" and "creates an event with ... canonical lower-case type"),
  // reached through the ValidationPipe + DTO on a real request. These two
  // tests instantiate the controller directly (bypassing both the pipe and
  // the recorder), so they now verify the controller's own remaining
  // responsibility: passing camera_id/type/detected_at through unmodified
  // and propagating whatever the recorder decides.
  it('propagates a rejection from the recorder for unsupported event types', async () => {
    const record = recordEventMock();
    record.mockRejectedValue(
      new BadRequestException(
        'type must be one of: detection-lost, bed-exit, fall',
      ),
    );
    const eventAlarm = {
      record,
    } as unknown as jest.Mocked<EventAlarmService>;
    const recorder = {} as EventRecorderService;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.record(edgeRequest(), {
        camera_id: 'camera-1',
        type: 'foo',
        detected_at: new Date('2026-06-26T01:02:03.456Z'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ cameraId: 'camera-1', type: 'foo' }),
    );
  });

  it('passes the raw event type through for the recorder to canonicalize', async () => {
    const record = recordEventMock();
    record.mockResolvedValue({ event: { id: 'event-1' }, duplicate: false });
    const eventAlarm = {
      record,
    } as unknown as jest.Mocked<EventAlarmService>;
    const recorder = {} as EventRecorderService;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.record(edgeRequest(), {
        camera_id: 'camera-1',
        type: ' DETECTION-LOST ',
        detected_at: new Date('2026-06-26T01:02:03.456Z'),
      }),
    ).resolves.toEqual({ id: 'event-1', status: 'created' });

    expect(record).toHaveBeenCalledWith({
      cameraId: 'camera-1',
      type: ' DETECTION-LOST ',
      detectedAt: new Date('2026-06-26T01:02:03.456Z'),
      confidence: undefined,
      configVersion: undefined,
      modelVersion: undefined,
      detectorVersion: undefined,
      operatingThreshold: undefined,
      snapshotKey: undefined,
      clockSource: undefined,
      clipId: undefined,
    });
  });

  it('passes optional clip_id through as clipId', async () => {
    const record = recordEventMock();
    record.mockResolvedValue({ event: { id: 'event-1' }, duplicate: false });
    const eventAlarm = {
      record,
    } as unknown as jest.Mocked<EventAlarmService>;
    const recorder = {} as EventRecorderService;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await controller.record(edgeRequest(), {
      camera_id: 'camera-1',
      type: 'fall',
      detected_at: new Date('2026-06-26T01:02:03.456Z'),
      clip_id: ' clip-123 ',
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ clipId: 'clip-123' }),
    );
  });
  it('accepts optional audit envelope fields and maps them to recorder input', async () => {
    const record = recordEventMock();
    record.mockResolvedValue({ event: { id: 'event-1' }, duplicate: false });
    const eventAlarm = {
      record,
    } as unknown as jest.Mocked<EventAlarmService>;
    const recorder = {} as EventRecorderService;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.record(edgeRequest(), {
        camera_id: 'camera-1',
        type: 'fall',
        detected_at: new Date('2026-06-26T01:02:03.456Z'),
        confidence: 0.91,
        config_version: 7,
        model_version: 'rf-nh-2026-07-04',
        detector_version: 'edge-detector-1.2.3',
        operating_threshold: 0.42,
        snapshot_key: 'events/event-1.jpg',
        clock_source: 'edge_wall_clock',
      }),
    ).resolves.toEqual({ id: 'event-1', status: 'created' });

    expect(record).toHaveBeenCalledWith({
      cameraId: 'camera-1',
      type: 'fall',
      detectedAt: new Date('2026-06-26T01:02:03.456Z'),
      confidence: 0.91,
      configVersion: 7,
      modelVersion: 'rf-nh-2026-07-04',
      detectorVersion: 'edge-detector-1.2.3',
      operatingThreshold: 0.42,
      snapshotKey: 'events/event-1.jpg',
      clockSource: 'edge_wall_clock',
      clipId: undefined,
    });
  });
});
describe('EventsController list', () => {
  it('passes the query to the recorder and returns the paginated response shape', async () => {
    const event = {
      id: 'event-1',
      facilityId: 'facility-1',
      cameraId: 'camera-1',
      spaceId: 'space-1',
      type: 'fall',
      confidence: 0.9,
      detectedAt: new Date('2026-06-26T01:02:03.456Z'),
      clipId: null,
      createdAt: new Date('2026-06-26T01:02:03.456Z'),
      modifiedAt: new Date('2026-06-26T01:02:03.456Z'),
      configVersion: null,
      modelVersion: null,
      detectorVersion: null,
      operatingThreshold: null,
      snapshotKey: null,
      clockSource: null,
    };
    const eventAlarm = {} as EventAlarmService;
    const list = jest.fn<Promise<unknown>, [string, unknown]>();
    list.mockResolvedValue({
      items: [event],
      nextCursor: 'opaque-cursor',
    });
    const recorder = {
      list,
    } as unknown as jest.Mocked<EventRecorderService>;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    const listed = await controller.list(
      { effectiveFacilityId: 'facility-1' } as never,
      { limit: 25, cursor: 'previous-cursor' },
    );

    expect(listed.nextCursor).toBe('opaque-cursor');
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: event.id,
      facilityId: event.facilityId,
    });
    expect(listed.items[0]).not.toHaveProperty('clipId');
    expect(list).toHaveBeenCalledWith('facility-1', {
      limit: 25,
      cursor: 'previous-cursor',
    });
  });
});
describe('EventsController heartbeat', () => {
  it('resolves the camera through event ingest and records a heartbeat', async () => {
    const eventAlarm = {} as EventAlarmService;
    const recorder = {} as EventRecorderService;
    const resolveForEventIngest = jest.fn<
      Promise<{
        readonly id: string;
        readonly facilityId: string;
        readonly spaceId: string;
      }>,
      [string]
    >();
    resolveForEventIngest.mockResolvedValue({
      id: 'camera-1',
      facilityId: 'facility-1',
      spaceId: 'space-1',
    });
    const recordHeartbeat = jest.fn<Promise<void>, [string, string]>();
    const cameras = {
      resolveForEventIngest,
      recordHeartbeat,
    } as unknown as jest.Mocked<CamerasService>;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.heartbeat({ camera_id: 'camera-1' }),
    ).resolves.toEqual({ ok: true });

    expect(resolveForEventIngest).toHaveBeenCalledWith('camera-1');
    expect(recordHeartbeat).toHaveBeenCalledWith('facility-1', 'camera-1');
  });

  it('propagates unknown camera rejection without recording a heartbeat', async () => {
    const eventAlarm = {} as EventAlarmService;
    const recorder = {} as EventRecorderService;
    const resolveForEventIngest = jest.fn<
      Promise<{
        readonly id: string;
        readonly facilityId: string;
        readonly spaceId: string;
      }>,
      [string]
    >();
    resolveForEventIngest.mockRejectedValue(
      new NotFoundException('unknown_camera'),
    );
    const recordHeartbeat = jest.fn<Promise<void>, [string, string]>();
    const cameras = {
      resolveForEventIngest,
      recordHeartbeat,
    } as unknown as jest.Mocked<CamerasService>;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.heartbeat({ camera_id: 'missing-camera' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(recordHeartbeat).not.toHaveBeenCalled();
  });
});

describe('EventsController guards', () => {
  it('guards snapshot uploads with the edge ingest token', () => {
    const uploadSnapshot: unknown = Object.getOwnPropertyDescriptor(
      EventsController.prototype,
      'uploadSnapshot',
    )?.value;
    if (typeof uploadSnapshot !== 'function') {
      throw new Error('EventsController.uploadSnapshot is not a method');
    }
    const guards: unknown = Reflect.getMetadata(
      GUARDS_METADATA,
      uploadSnapshot,
    );

    expect(guards).toContain(EdgeIngestTokenGuard);
  });
});
describe('EventsController uploadSnapshot', () => {
  let snapshotDir: string | undefined;

  afterEach(async () => {
    if (snapshotDir) {
      await fs.promises.rm(snapshotDir, { recursive: true, force: true });
      snapshotDir = undefined;
    }
    delete process.env.SNAPSHOT_DIR;
  });

  function makeRawRequest(
    body: Buffer,
    options: {
      contentType?: string;
      query?: Record<string, unknown>;
      parsedBody?: unknown;
    } = {},
  ) {
    return {
      headers: { 'content-type': options.contentType ?? 'image/jpeg' },
      query: options.query,
      body: options.parsedBody,
      *[Symbol.iterator]() {
        yield body;
      },
    };
  }

  it('derives the snapshot key from the resolved event id and persists it', async () => {
    snapshotDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'event-snapshot-'),
    );
    process.env.SNAPSHOT_DIR = snapshotDir;
    const eventAlarm = {} as EventAlarmService;
    const resolveForSnapshot = jest.fn<
      Promise<{ readonly id: string; readonly facilityId: string }>,
      [string, string | null | undefined]
    >();
    resolveForSnapshot.mockResolvedValue({
      id: 'event-created-id',
      facilityId: 'facility-1',
    });
    const persistSnapshotKey = jest.fn<
      Promise<void>,
      [string, string, string]
    >();
    const recorder = {
      resolveForSnapshot,
      persistSnapshotKey,
    } as unknown as jest.Mocked<EventRecorderService>;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);
    const req = makeRawRequest(Buffer.from('jpeg-bytes'));

    await expect(
      controller.uploadSnapshot(req as never, 'client-route-id'),
    ).resolves.toEqual({ snapshotKey: 'facility-1/event-created-id.jpg' });

    expect(resolveForSnapshot).toHaveBeenCalledWith('client-route-id', null);
    expect(persistSnapshotKey).toHaveBeenCalledWith(
      'facility-1',
      'event-created-id',
      'facility-1/event-created-id.jpg',
    );
    await expect(
      fs.promises.readFile(
        path.join(snapshotDir, 'facility-1', 'event-created-id.jpg'),
      ),
    ).resolves.toEqual(Buffer.from('jpeg-bytes'));
  });

  it('rejects client-supplied snapshot keys', async () => {
    const eventAlarm = {} as EventAlarmService;
    const resolveForSnapshot = jest.fn<
      Promise<{ readonly id: string; readonly facilityId: string }>,
      [string, string | null | undefined]
    >();
    const persistSnapshotKey = jest.fn<
      Promise<void>,
      [string, string, string]
    >();
    const recorder = {
      resolveForSnapshot,
      persistSnapshotKey,
    } as unknown as jest.Mocked<EventRecorderService>;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.uploadSnapshot(
        makeRawRequest(Buffer.from('jpeg-bytes'), {
          query: { snapshotKey: 'facility-1/client.jpg' },
        }) as never,
        'event-1',
      ),
    ).rejects.toThrow('snapshot key is server-derived');
    await expect(
      controller.uploadSnapshot(
        makeRawRequest(Buffer.from('jpeg-bytes'), {
          parsedBody: { snapshot_key: 'facility-1/client.jpg' },
        }) as never,
        'event-1',
      ),
    ).rejects.toThrow('snapshot key is server-derived');
    expect(resolveForSnapshot).not.toHaveBeenCalled();
  });

  it('rejects unsupported snapshot content types', async () => {
    const eventAlarm = {} as EventAlarmService;
    const resolveForSnapshot = jest.fn<
      Promise<{ readonly id: string; readonly facilityId: string }>,
      [string, string | null | undefined]
    >();
    const persistSnapshotKey = jest.fn<
      Promise<void>,
      [string, string, string]
    >();
    const recorder = {
      resolveForSnapshot,
      persistSnapshotKey,
    } as unknown as jest.Mocked<EventRecorderService>;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.uploadSnapshot(
        makeRawRequest(Buffer.from('gif-bytes'), {
          contentType: 'image/gif',
        }) as never,
        'event-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveForSnapshot).not.toHaveBeenCalled();
  });
});
