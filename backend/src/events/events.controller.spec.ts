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
    const eventAlarm = {
      record: jest
        .fn()
        .mockRejectedValue(
          new BadRequestException(
            'type must be one of: detection-lost, bed-exit, fall',
          ),
        ),
    } as unknown as jest.Mocked<EventAlarmService>;
    const recorder = {} as EventRecorderService;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.record({
        camera_id: 'camera-1',
        type: 'foo',
        detected_at: new Date('2026-06-26T01:02:03.456Z'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(eventAlarm.record).toHaveBeenCalledWith(
      expect.objectContaining({ cameraId: 'camera-1', type: 'foo' }),
    );
  });

  it('passes the raw event type through for the recorder to canonicalize', async () => {
    const eventAlarm = {
      record: jest.fn().mockResolvedValue({
        event: { id: 'event-1' },
        duplicate: false,
      }),
    } as unknown as jest.Mocked<EventAlarmService>;
    const recorder = {} as EventRecorderService;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.record({
        camera_id: 'camera-1',
        type: ' DETECTION-LOST ',
        detected_at: new Date('2026-06-26T01:02:03.456Z'),
      }),
    ).resolves.toEqual({ id: 'event-1', status: 'created' });

    expect(eventAlarm.record).toHaveBeenCalledWith({
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
    const eventAlarm = {
      record: jest.fn().mockResolvedValue({
        event: { id: 'event-1' },
        duplicate: false,
      }),
    } as unknown as jest.Mocked<EventAlarmService>;
    const recorder = {} as EventRecorderService;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await controller.record({
      camera_id: 'camera-1',
      type: 'fall',
      detected_at: new Date('2026-06-26T01:02:03.456Z'),
      clip_id: ' clip-123 ',
    });

    expect(eventAlarm.record).toHaveBeenCalledWith(
      expect.objectContaining({ clipId: 'clip-123' }),
    );
  });
  it('accepts optional audit envelope fields and maps them to recorder input', async () => {
    const eventAlarm = {
      record: jest.fn().mockResolvedValue({
        event: { id: 'event-1' },
        duplicate: false,
      }),
    } as unknown as jest.Mocked<EventAlarmService>;
    const recorder = {} as EventRecorderService;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.record({
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

    expect(eventAlarm.record).toHaveBeenCalledWith({
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
describe('EventsController heartbeat', () => {
  it('resolves the camera through event ingest and records a heartbeat', async () => {
    const eventAlarm = {} as EventAlarmService;
    const recorder = {} as EventRecorderService;
    const cameras = {
      resolveForEventIngest: jest.fn().mockResolvedValue({
        id: 'camera-1',
        facilityId: 'facility-1',
        spaceId: 'space-1',
      }),
      recordHeartbeat: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<CamerasService>;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.heartbeat({ camera_id: 'camera-1' }),
    ).resolves.toEqual({ ok: true });

    expect(cameras.resolveForEventIngest).toHaveBeenCalledWith('camera-1');
    expect(cameras.recordHeartbeat).toHaveBeenCalledWith(
      'facility-1',
      'camera-1',
    );
  });

  it('propagates unknown camera rejection without recording a heartbeat', async () => {
    const eventAlarm = {} as EventAlarmService;
    const recorder = {} as EventRecorderService;
    const cameras = {
      resolveForEventIngest: jest
        .fn()
        .mockRejectedValue(new NotFoundException('unknown_camera')),
      recordHeartbeat: jest.fn(),
    } as unknown as jest.Mocked<CamerasService>;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.heartbeat({ camera_id: 'missing-camera' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(cameras.recordHeartbeat).not.toHaveBeenCalled();
  });
});

describe('EventsController guards', () => {
  it('guards snapshot uploads with the edge ingest token', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      EventsController.prototype.uploadSnapshot,
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
      async *[Symbol.asyncIterator]() {
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
    const recorder = {
      resolveForSnapshot: jest.fn().mockResolvedValue({
        id: 'event-created-id',
        facilityId: 'facility-1',
      }),
      persistSnapshotKey: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<EventRecorderService>;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);
    const req = makeRawRequest(Buffer.from('jpeg-bytes'));

    await expect(
      controller.uploadSnapshot(req as never, 'client-route-id'),
    ).resolves.toEqual({ snapshotKey: 'facility-1/event-created-id.jpg' });

    expect(recorder.resolveForSnapshot).toHaveBeenCalledWith('client-route-id');
    expect(recorder.persistSnapshotKey).toHaveBeenCalledWith(
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
    const recorder = {
      resolveForSnapshot: jest.fn(),
      persistSnapshotKey: jest.fn(),
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
    expect(recorder.resolveForSnapshot).not.toHaveBeenCalled();
  });

  it('rejects unsupported snapshot content types', async () => {
    const eventAlarm = {} as EventAlarmService;
    const recorder = {
      resolveForSnapshot: jest.fn(),
      persistSnapshotKey: jest.fn(),
    } as unknown as jest.Mocked<EventRecorderService>;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.uploadSnapshot(
        makeRawRequest(Buffer.from('gif-bytes'), { contentType: 'image/gif' }) as never,
        'event-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(recorder.resolveForSnapshot).not.toHaveBeenCalled();
  });
});
