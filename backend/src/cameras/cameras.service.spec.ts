import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CamerasService } from './cameras.service';

type CameraDelegate = {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
};

function setup() {
  const camera: CameraDelegate = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const prisma = {
    withOrgContext: jest.fn(
      (_orgId: string, cb: (tx: { camera: CameraDelegate }) => unknown) =>
        cb({ camera }),
    ),
  } as unknown as PrismaService;
  return { service: new CamerasService(prisma), camera };
}

const fullCamera = {
  id: 'c1',
  orgId: 'org-1',
  residentId: null,
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
      service.create('org-1', { label: '  ' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(camera.create).not.toHaveBeenCalled();
  });

  it('generates an ingestKeyId and never leaks the secret hash in the DTO', async () => {
    const { service, camera } = setup();
    camera.create.mockResolvedValue(fullCamera);
    const result = await service.create('org-1', { label: 'Room 1' });

    const createArg = camera.create.mock.calls[0][0].data;
    expect(createArg.ingestKeyId).toMatch(/^cam-[0-9a-f]+$/);
    expect(typeof createArg.ingestSecretHash).toBe('string');
    expect(result).not.toHaveProperty('ingestSecretHash');
    expect(result.ingestKeyId).toBe('cam-abc');
  });

  it('throws NotFound when getOne misses', async () => {
    const { service, camera } = setup();
    camera.findUnique.mockResolvedValue(null);
    await expect(service.getOne('org-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
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
    await expect(service.remove('org-1', 'c1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
