import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { MissingTenantContextError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { CamerasService } from './cameras.service';

describe('CamerasService event ingest resolver', () => {
  let direct: PrismaClient;
  let prisma: PrismaService;
  let service: CamerasService;

  beforeAll(async () => {
    if (!process.env.DIRECT_URL || !process.env.DATABASE_URL) {
      throw new Error(
        'DIRECT_URL and DATABASE_URL are required for event ingest resolver tests',
      );
    }

    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    prisma = new PrismaService();
    service = new CamerasService(prisma);

    await direct.$connect();
    await prisma.onModuleInit();

    await direct.camera.deleteMany({
      where: { id: 'event-ingest-camera' },
    });
    await direct.space.deleteMany({ where: { id: 'event-ingest-space' } });
    await direct.floor.deleteMany({ where: { id: 'event-ingest-floor' } });
    await direct.facility.deleteMany({
      where: { id: 'event-ingest-facility' },
    });

    await direct.facility.create({
      data: {
        id: 'event-ingest-facility',
        name: 'Event Ingest Facility',
        code: 'event-ingest-facility',
      },
    });
    await direct.floor.create({
      data: {
        id: 'event-ingest-floor',
        facilityId: 'event-ingest-facility',
        name: 'Event Ingest Floor',
        orderIndex: 1,
      },
    });
    await direct.space.create({
      data: {
        id: 'event-ingest-space',
        facilityId: 'event-ingest-facility',
        floorId: 'event-ingest-floor',
        name: 'Event Ingest Room',
        type: 'ROOM',
        capacity: 1,
      },
    });
    await direct.camera.create({
      data: {
        id: 'event-ingest-camera',
        facilityId: 'event-ingest-facility',
        spaceId: 'event-ingest-space',
        label: 'Event Ingest Camera',
      },
    });
  });

  afterAll(async () => {
    await direct.camera.deleteMany({
      where: { id: 'event-ingest-camera' },
    });
    await direct.space.deleteMany({ where: { id: 'event-ingest-space' } });
    await direct.floor.deleteMany({ where: { id: 'event-ingest-floor' } });
    await direct.facility.deleteMany({
      where: { id: 'event-ingest-facility' },
    });

    await prisma.onModuleDestroy();
    await direct.$disconnect();
  });

  it('resolves a known camera to the narrow facility and space identity', async () => {
    await expect(
      service.resolveForEventIngest('event-ingest-camera'),
    ).resolves.toEqual({
      id: 'event-ingest-camera',
      facilityId: 'event-ingest-facility',
      spaceId: 'event-ingest-space',
    });
  });

  it('rejects an unknown camera id without leaking ingest details', async () => {
    await expect(
      service.resolveForEventIngest('missing-event-ingest-camera'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not return secret or other non-topology camera fields', async () => {
    const result = await service.resolveForEventIngest('event-ingest-camera');

    expect(Object.keys(result).sort()).toEqual(['facilityId', 'id', 'spaceId']);
    for (const key of [`ingest${'KeyId'}`, `ingest${'SecretHash'}`]) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result).not.toHaveProperty('label');
  });

  it('keeps direct camera model access blocked without a facility context', async () => {
    await expect(
      prisma.db.camera.findUnique({ where: { id: 'event-ingest-camera' } }),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });
});
