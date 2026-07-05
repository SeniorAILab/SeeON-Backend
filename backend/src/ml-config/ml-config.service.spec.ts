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

const cameraRow = {
  id: 'camera-1',
  spaceId: 'space-1',
  label: 'Room 1',
  rtspUrl: 'rtsp://camera.local/live',
  online: true,
};

describe('MlConfigService', () => {
  it('returns rtspUrl, night window, and configVersion from a config row', async () => {
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
      cameras: [cameraRow],
    });
  });

  it('returns default config without creating a row when config is absent', async () => {
    const { service, camera, mlFacilityConfig } = setup();
    camera.findMany.mockResolvedValue([{ ...cameraRow, rtspUrl: null }]);
    mlFacilityConfig.findUnique.mockResolvedValue(null);

    await expect(service.getConfig('facility-1')).resolves.toEqual({
      configVersion: 0,
      nightWindow: { start: '21:00', end: '07:00', tz: 'Asia/Seoul' },
      cameras: [{ ...cameraRow, rtspUrl: null }],
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
