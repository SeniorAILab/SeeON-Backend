import { ConflictException } from '@nestjs/common';
import { Prisma, ProvisioningSource } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { CamerasService } from './cameras.service';

type CameraRecord = {
  id: string;
  facilityId: string;
  spaceId: string;
  label: string;
  rtspUrl: string | null;
  lastSeenAt: null;
  online: boolean;
  provisioningSource: ProvisioningSource;
  createdAt: Date;
};

type CameraDelegate = {
  upsert: jest.Mock<Promise<CameraRecord>, [unknown]>;
  findUnique: jest.Mock<Promise<CameraRecord | null>, [unknown]>;
};

type MlFacilityConfigDelegate = {
  upsert: jest.Mock;
};

function setup() {
  const camera: CameraDelegate = {
    upsert: jest.fn<Promise<CameraRecord>, [unknown]>(),
    findUnique: jest.fn<Promise<CameraRecord | null>, [unknown]>(),
  };
  camera.findUnique.mockResolvedValue(null);
  const mlFacilityConfig: MlFacilityConfigDelegate = {
    upsert: jest.fn(),
  };
  const prisma = {
    withFacilityContext: jest.fn(
      (
        _facilityId: string,
        cb: (tx: {
          camera: CameraDelegate;
          mlFacilityConfig: MlFacilityConfigDelegate;
        }) => unknown,
      ) => cb({ camera, mlFacilityConfig }),
    ),
  } as unknown as PrismaService;
  return { service: new CamerasService(prisma), camera, mlFacilityConfig };
}

function cameraRecord(overrides: Partial<CameraRecord> = {}): CameraRecord {
  return {
    id: 'camera-backend-1',
    facilityId: 'facility-1',
    spaceId: 'space-1',
    label: 'Room 1 camera',
    rtspUrl: null,
    lastSeenAt: null,
    online: false,
    provisioningSource: ProvisioningSource.PRODUCT,
    createdAt: new Date('2026-07-06T00:00:00.000Z'),
    ...overrides,
  };
}

describe('CamerasService edge camera mapping', () => {
  it('idempotently upserts a facility-scoped space mapping and returns the canonical camera id', async () => {
    const { service, camera } = setup();
    camera.upsert.mockResolvedValue(cameraRecord());

    await expect(
      service.upsertEdgeCameraMapping('facility-1', {
        edge_camera_ref: 'edge-local-cam-1',
        label: ' Room 1 camera ',
        spaceId: ' space-1 ',
      }),
    ).resolves.toEqual({
      cameraId: 'camera-backend-1',
      facilityId: 'facility-1',
      spaceId: 'space-1',
    });

    expect(camera.upsert).toHaveBeenCalledWith({
      where: {
        facilityId_spaceId: { facilityId: 'facility-1', spaceId: 'space-1' },
      },
      create: {
        facilityId: 'facility-1',
        label: 'Room 1 camera',
        spaceId: 'space-1',
      },
      update: { label: 'Room 1 camera' },
    });
  });

  it('keeps the backend-issued canonical id stable on repeated mapping updates', async () => {
    const { service, camera } = setup();
    camera.upsert
      .mockResolvedValueOnce(cameraRecord())
      .mockResolvedValueOnce(cameraRecord({ label: 'Updated camera label' }));

    const first = await service.upsertEdgeCameraMapping('facility-1', {
      edge_camera_ref: 'edge-local-cam-1',
      label: 'Room 1 camera',
      spaceId: 'space-1',
    });
    const second = await service.upsertEdgeCameraMapping('facility-1', {
      edge_camera_ref: 'edge-local-cam-1',
      label: 'Updated camera label',
      spaceId: 'space-1',
    });

    expect(second.cameraId).toBe(first.cameraId);
    expect(camera.upsert).toHaveBeenCalledTimes(2);
  });

  it('bumps the ML config version inside the mapping transaction', async () => {
    const { service, camera, mlFacilityConfig } = setup();
    camera.upsert.mockResolvedValue(cameraRecord());

    await service.upsertEdgeCameraMapping('facility-1', {
      edge_camera_ref: 'edge-local-cam-1',
      label: 'Room 1 camera',
      spaceId: 'space-1',
    });

    expect(mlFacilityConfig.upsert).toHaveBeenCalledWith({
      where: { facilityId: 'facility-1' },
      create: { facilityId: 'facility-1', configVersion: 1 },
      update: { configVersion: { increment: 1 } },
    });
  });

  it('rejects a blank edge-local reference before writing', async () => {
    const { service, camera } = setup();

    await expect(
      service.upsertEdgeCameraMapping('facility-1', {
        edge_camera_ref: ' ',
        label: 'Room 1 camera',
        spaceId: 'space-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(camera.upsert).not.toHaveBeenCalled();
  });

  it('rejects a space that cannot be written inside the facility scope', async () => {
    const { service, camera } = setup();
    camera.upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('foreign key', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.upsertEdgeCameraMapping('facility-1', {
        edge_camera_ref: 'edge-local-cam-1',
        label: 'Room 1 camera',
        spaceId: 'other-facility-space',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to overwrite a row already owned by an enrolled Edge installation', async () => {
    const { service, camera } = setup();
    camera.findUnique.mockResolvedValue(
      cameraRecord({ provisioningSource: ProvisioningSource.EDGE }),
    );

    await expect(
      service.upsertEdgeCameraMapping('facility-1', {
        edge_camera_ref: 'edge-local-cam-1',
        label: 'Attempted overwrite',
        spaceId: 'space-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(camera.upsert).not.toHaveBeenCalled();
  });
});
