import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { CamerasService } from './cameras.service';

type CameraCreateArg = {
  data: {
    ingestKeyId: string;
    ingestSecretHash: string;
    spaceId: string;
  };
};

type CameraDelegate = {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  create: jest.Mock<Promise<typeof fullCamera>, [CameraCreateArg]>;
  update: jest.Mock;
  delete: jest.Mock;
};

function setup() {
  const camera: CameraDelegate = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn<Promise<typeof fullCamera>, [CameraCreateArg]>(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const prisma = {
    withFacilityContext: jest.fn(
      (_facilityId: string, cb: (tx: { camera: CameraDelegate }) => unknown) =>
        cb({ camera }),
    ),
  } as unknown as PrismaService;
  return { service: new CamerasService(prisma), camera };
}

const fullCamera = {
  id: 'c1',
  facilityId: 'facility-1',
  residentId: null,
  spaceId: 'space-1',
  label: 'Room 1',
  ingestKeyId: 'cam-abc',
  ingestSecretHash: 'secret-should-not-leak',
  lastSeenAt: null,
  online: false,
  createdAt: new Date('2026-06-16T00:00:00.000Z'),
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

  it('generates an ingestKeyId and never leaks the secret hash in the DTO', async () => {
    const { service, camera } = setup();
    camera.create.mockResolvedValue(fullCamera);
    const result = await service.create('facility-1', {
      label: 'Room 1',
      spaceId: 'space-1',
    });

    const createArg = camera.create.mock.calls[0][0].data;
    expect(createArg.ingestKeyId).toMatch(/^cam-[0-9a-f]+$/);
    expect(typeof createArg.ingestSecretHash).toBe('string');
    expect(result).not.toHaveProperty('ingestSecretHash');
    expect(result.ingestKeyId).toBe('cam-abc');
    expect(result.spaceId).toBe('space-1');
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
});
