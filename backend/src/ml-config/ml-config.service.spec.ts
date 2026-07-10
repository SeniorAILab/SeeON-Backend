import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { MlConfigService } from './ml-config.service.js';
import { bumpMlConfigVersion } from './ml-config.version.js';

type CameraDelegate = { findMany: jest.Mock };
type MlFacilityConfigDelegate = {
  findUnique: jest.Mock;
  upsert: jest.Mock;
};

type MockTx = {
  camera: CameraDelegate;
  mlFacilityConfig: MlFacilityConfigDelegate;
};

function setup() {
  const camera: CameraDelegate = { findMany: jest.fn() };
  const mlFacilityConfig: MlFacilityConfigDelegate = {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  };
  const tx = { camera, mlFacilityConfig };
  const prisma = {
    withFacilityContext: jest.fn(
      (_facilityId: string, cb: (tx: MockTx) => unknown) => cb(tx),
    ),
  } as unknown as PrismaService;
  return { service: new MlConfigService(prisma), camera, mlFacilityConfig, tx };
}

const createdAt = new Date('2026-07-10T12:34:56.789Z');
const cameraRow = {
  id: 'camera-1',
  spaceId: 'space-1',
  label: 'Room 1',
  rtspUrl: 'rtsp://camera.local/live',
  online: true,
  createdAt,
  space: { name: 'Room 101', floor: { name: '1F' } },
};

describe('MlConfigService', () => {
  it('returns additive camera location metadata and ISO creation time from a config row', async () => {
    const { service, camera, mlFacilityConfig } = setup();
    camera.findMany.mockResolvedValue([cameraRow]);
    mlFacilityConfig.findUnique.mockResolvedValue({
      facilityId: 'facility-1',
      configVersion: 7,
      nightStart: '22:00',
      nightEnd: '06:30',
      tz: 'Asia/Seoul',
    });

    await expect(service.getConfig('facility-1')).resolves.toEqual({
      configVersion: 7,
      nightWindow: { start: '22:00', end: '06:30', tz: 'Asia/Seoul' },
      cameras: [
        {
          id: 'camera-1',
          spaceId: 'space-1',
          label: 'Room 1',
          rtspUrl: 'rtsp://camera.local/live',
          online: true,
          spaceName: 'Room 101',
          floorName: '1F',
          createdAt: '2026-07-10T12:34:56.789Z',
        },
      ],
    });
    expect(camera.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        spaceId: true,
        label: true,
        rtspUrl: true,
        online: true,
        createdAt: true,
        space: {
          select: {
            name: true,
            floor: { select: { name: true } },
          },
        },
      },
    });
  });

  it('returns null location metadata when a camera has no loaded space or floor', async () => {
    const { service, camera, mlFacilityConfig } = setup();
    camera.findMany.mockResolvedValue([
      { ...cameraRow, rtspUrl: null, space: null },
      {
        ...cameraRow,
        id: 'camera-2',
        spaceId: 'space-2',
        label: 'Hallway',
        space: { name: 'Hallway', floor: null },
      },
    ]);
    mlFacilityConfig.findUnique.mockResolvedValue(null);

    await expect(service.getConfig('facility-1')).resolves.toEqual({
      configVersion: 0,
      nightWindow: { start: '21:00', end: '07:00', tz: 'Asia/Seoul' },
      cameras: [
        {
          id: 'camera-1',
          spaceId: 'space-1',
          label: 'Room 1',
          rtspUrl: null,
          online: true,
          spaceName: null,
          floorName: null,
          createdAt: '2026-07-10T12:34:56.789Z',
        },
        {
          id: 'camera-2',
          spaceId: 'space-2',
          label: 'Hallway',
          rtspUrl: 'rtsp://camera.local/live',
          online: true,
          spaceName: 'Hallway',
          floorName: null,
          createdAt: '2026-07-10T12:34:56.789Z',
        },
      ],
    });
    expect(mlFacilityConfig.upsert).not.toHaveBeenCalled();
  });

  it('bumpMlConfigVersion upserts monotonic create and update args', async () => {
    const { tx, mlFacilityConfig } = setup();

    await bumpMlConfigVersion(tx as never, 'facility-1');

    expect(mlFacilityConfig.upsert).toHaveBeenCalledWith({
      where: { facilityId: 'facility-1' },
      create: { facilityId: 'facility-1', configVersion: 1 },
      update: { configVersion: { increment: 1 } },
    });
  });

  it('rejects bad HH:MM night-window values', async () => {
    const { service, mlFacilityConfig } = setup();

    await expect(
      service.updateNightWindow('facility-1', {
        start: '24:00',
        end: '07:00',
        tz: 'Asia/Seoul',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mlFacilityConfig.upsert).not.toHaveBeenCalled();
  });

  it('bumps configVersion on a valid night-window update', async () => {
    const { service, camera, mlFacilityConfig } = setup();
    camera.findMany.mockResolvedValue([]);
    mlFacilityConfig.findUnique.mockResolvedValue({
      facilityId: 'facility-1',
      configVersion: 2,
      nightStart: '20:30',
      nightEnd: '05:45',
      tz: 'Asia/Seoul',
    });

    await service.updateNightWindow('facility-1', {
      start: '20:30',
      end: '05:45',
      tz: 'Asia/Seoul',
    });

    expect(mlFacilityConfig.upsert).toHaveBeenCalledWith({
      where: { facilityId: 'facility-1' },
      create: {
        facilityId: 'facility-1',
        configVersion: 1,
        nightStart: '20:30',
        nightEnd: '05:45',
        tz: 'Asia/Seoul',
      },
      update: {
        nightStart: '20:30',
        nightEnd: '05:45',
        tz: 'Asia/Seoul',
        configVersion: { increment: 1 },
      },
    });
  });
});
