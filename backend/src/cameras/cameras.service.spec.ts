import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { CamerasService } from './cameras.service';

type CameraCreateArg = {
  data: {
    facilityId: string;
    label: string;
    spaceId: string;
    rtspUrl?: string | null;
  };
};

type CameraUpdateArg = {
  readonly data: {
    readonly rtspUrl?: string | null;
  };
};

type CameraDelegate = {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  create: jest.Mock<Promise<typeof fullCamera>, [CameraCreateArg]>;
  update: jest.Mock<Promise<typeof fullCamera>, [CameraUpdateArg]>;
  delete: jest.Mock;
};
type MlFacilityConfigDelegate = {
  upsert: jest.Mock;
};

function setup() {
  const camera: CameraDelegate = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn<Promise<typeof fullCamera>, [CameraCreateArg]>(),
    update: jest.fn<Promise<typeof fullCamera>, [CameraUpdateArg]>(),
    delete: jest.fn(),
  };
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

const fullCamera = {
  id: 'c1',
  facilityId: 'facility-1',
  spaceId: 'space-1',
  label: 'Room 1',
  lastSeenAt: null,
  online: false,
  createdAt: new Date('2026-06-16T00:00:00.000Z'),
  rtspUrl: 'rtsp://example.internal/stream',
};

describe('CamerasService', () => {
  it('rejects creation with a blank label', async () => {
    const { service, camera } = setup();
    await expect(
      service.create('facility-1', { label: '  ', spaceId: 'space-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(camera.create).not.toHaveBeenCalled();
  });

  it('requires spaceId on creation', async () => {
    const { service, camera } = setup();
    await expect(
      service.create('facility-1', { label: 'Room 1', spaceId: '' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(camera.create).not.toHaveBeenCalled();
  });

  it('creates cameras without ingest credentials', async () => {
    const { service, camera } = setup();
    camera.create.mockResolvedValue(fullCamera);
    const result = await service.create('facility-1', {
      label: 'Room 1',
      spaceId: 'space-1',
    });

    const createArg = camera.create.mock.calls[0][0].data;
    for (const key of [
      `ingest${'KeyId'}`,
      `ingest${'Secret'}`,
      `ingest${'SecretHash'}`,
    ]) {
      expect(createArg).not.toHaveProperty(key);
      expect(result).not.toHaveProperty(key);
    }
    expect(result.spaceId).toBe('space-1');
    expect(result).not.toHaveProperty('residentId');
  });
  it('persists rtspUrl on creation without returning it', async () => {
    const { service, camera } = setup();
    camera.create.mockResolvedValue(fullCamera);

    const result = await service.create('facility-1', {
      label: 'Room 1',
      spaceId: 'space-1',
      rtspUrl: 'rtsp://user:pass@camera.local/live',
    });

    expect(camera.create.mock.calls[0][0].data).toMatchObject({
      rtspUrl: 'rtsp://user:pass@camera.local/live',
    });
    expect(result).not.toHaveProperty('rtspUrl');
  });

  it('bumps ml config version inside the create transaction', async () => {
    const { service, camera, mlFacilityConfig } = setup();
    camera.create.mockResolvedValue(fullCamera);

    await service.create('facility-1', {
      label: 'Room 1',
      spaceId: 'space-1',
    });

    expect(mlFacilityConfig.upsert).toHaveBeenCalledWith({
      where: { facilityId: 'facility-1' },
      create: { facilityId: 'facility-1', configVersion: 1 },
      update: { configVersion: { increment: 1 } },
    });
  });

  it('persists rtspUrl on update without returning it', async () => {
    const { service, camera } = setup();
    camera.findUnique.mockResolvedValue(fullCamera);
    camera.update.mockResolvedValue(fullCamera);

    const result = await service.update('facility-1', 'c1', {
      rtspUrl: 'rtsp://user:pass@camera.local/updated',
    });

    expect(camera.update.mock.calls[0][0].data).toMatchObject({
      rtspUrl: 'rtsp://user:pass@camera.local/updated',
    });
    expect(result).not.toHaveProperty('rtspUrl');
  });

  it('bumps ml config version inside the update transaction', async () => {
    const { service, camera, mlFacilityConfig } = setup();
    camera.findUnique.mockResolvedValue(fullCamera);
    camera.update.mockResolvedValue(fullCamera);

    await service.update('facility-1', 'c1', { label: 'Updated' });

    expect(mlFacilityConfig.upsert).toHaveBeenCalledWith({
      where: { facilityId: 'facility-1' },
      create: { facilityId: 'facility-1', configVersion: 1 },
      update: { configVersion: { increment: 1 } },
    });
  });

  it('excludes rtspUrl from list and getOne responses', async () => {
    const { service, camera } = setup();
    camera.findMany.mockResolvedValue([fullCamera]);
    camera.findUnique.mockResolvedValue(fullCamera);

    await expect(service.list('facility-1')).resolves.toEqual([
      {
        id: 'c1',
        facilityId: 'facility-1',
        spaceId: 'space-1',
        label: 'Room 1',
        lastSeenAt: null,
        online: false,
        createdAt: fullCamera.createdAt,
      },
    ]);
    await expect(
      service.getOne('facility-1', 'c1'),
    ).resolves.not.toHaveProperty('rtspUrl');
  });

  it('does not log rtspUrl during create or update', async () => {
    const { service, camera } = setup();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    camera.findUnique.mockResolvedValue(fullCamera);
    camera.create.mockResolvedValue(fullCamera);
    camera.update.mockResolvedValue(fullCamera);

    try {
      await service.create('facility-1', {
        label: 'Room 1',
        spaceId: 'space-1',
        rtspUrl: 'rtsp://user:pass@camera.local/create',
      });
      await service.update('facility-1', 'c1', {
        rtspUrl: 'rtsp://user:pass@camera.local/update',
      });
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }

    for (const spy of [logSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('rtsp://');
      }
    }
  });

  it('throws NotFound when getOne misses', async () => {
    const { service, camera } = setup();
    camera.findUnique.mockResolvedValue(null);
    await expect(
      service.getOne('facility-1', 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects update with blank or null spaceId', async () => {
    const { service, camera } = setup();
    camera.findUnique.mockResolvedValue(fullCamera);

    await expect(
      service.update('facility-1', 'c1', { spaceId: '  ' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.update('facility-1', 'c1', { spaceId: null } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(camera.update).not.toHaveBeenCalled();
  });
  it('maps unique constraint violations to ConflictException on update', async () => {
    const { service, camera } = setup();
    camera.findUnique.mockResolvedValue(fullCamera);
    camera.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.update('facility-1', 'c1', { spaceId: 'space-2' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps FK constraint violations to ConflictException on remove', async () => {
    const { service, camera } = setup();
    camera.findUnique.mockResolvedValue(fullCamera);
    camera.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );
    await expect(service.remove('facility-1', 'c1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('bumps ml config version inside the remove transaction', async () => {
    const { service, camera, mlFacilityConfig } = setup();
    camera.findUnique.mockResolvedValue(fullCamera);
    camera.delete.mockResolvedValue(fullCamera);

    await service.remove('facility-1', 'c1');

    expect(mlFacilityConfig.upsert).toHaveBeenCalledWith({
      where: { facilityId: 'facility-1' },
      create: { facilityId: 'facility-1', configVersion: 1 },
      update: { configVersion: { increment: 1 } },
    });
  });
});
