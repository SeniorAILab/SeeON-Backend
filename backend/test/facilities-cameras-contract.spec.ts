import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, Role } from '@prisma/client';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SESSION_COOKIE_NAME } from '../src/auth/auth.constants';
import { AppModule } from '../src/app.module';

import { configureVersionedTestApp } from './helpers/versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';
const PREFIX = 'fac-cam-contract-b2';
const EDGE_TOKEN = 'fac-cam-contract-b2-edge-token';

describe('Facilities and cameras response contracts (e2e)', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;

  beforeAll(async () => {
    process.env.SESSION_JWT_SECRET = TEST_SECRET;
    process.env.FRONT_ORIGIN = 'http://localhost:3000';
    process.env.EDGE_FACILITY_TOKEN = EDGE_TOKEN;

    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    await direct.$connect();
  });

  beforeEach(async () => {
    await cleanup();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  afterAll(async () => {
    await direct.$disconnect();
  });

  it('PATCH /facilities/:id updates only mutable facility fields', async () => {
    const seeded = await seedFacilityGraph('patch-success');
    const adminCookie = await seedSessionCookie(
      seeded.facilityId,
      'patch-success-admin',
      Role.ADMIN,
    );

    const response = await request(app.getHttpServer())
      .patch(`/api/v1/facilities/${seeded.facilityId}`)
      .set('cookie', adminCookie)
      .send({
        name: '  Updated Facility  ',
        address: '  123 Main  ',
        phone: '',
      })
      .expect(200);

    expect(response.body).toEqual({
      id: seeded.facilityId,
      name: 'Updated Facility',
      address: '123 Main',
      phone: null,
      createdAt: seeded.facilityCreatedAt.toISOString(),
    });
    await expect(
      direct.facility.findUniqueOrThrow({ where: { id: seeded.facilityId } }),
    ).resolves.toMatchObject({
      name: 'Updated Facility',
      address: '123 Main',
      phone: null,
    });
  });

  it('PATCH /facilities/:id denies other facilities and STAFF with 403', async () => {
    const first = await seedFacilityGraph('patch-deny-a');
    const second = await seedFacilityGraph('patch-deny-b');
    const firstAdminCookie = await seedSessionCookie(
      first.facilityId,
      'patch-deny-admin',
      Role.ADMIN,
    );
    const firstStaffCookie = await seedSessionCookie(
      first.facilityId,
      'patch-deny-staff',
      Role.STAFF,
    );

    const otherFacility = await request(app.getHttpServer())
      .patch(`/api/v1/facilities/${second.facilityId}`)
      .set('cookie', firstAdminCookie)
      .send({ name: 'Cross Facility' })
      .expect(403);
    expect(otherFacility.body).toEqual({
      error: 'Forbidden',
      message: 'Facility scope mismatch',
      statusCode: 403,
    });

    const staff = await request(app.getHttpServer())
      .patch(`/api/v1/facilities/${first.facilityId}`)
      .set('cookie', firstStaffCookie)
      .send({ name: 'Staff Facility' })
      .expect(403);
    expect(staff.body).toEqual({
      error: 'Forbidden',
      message: 'Insufficient role capability',
      statusCode: 403,
    });
  });

  it('GET /cameras and /cameras/:id expose online and lastSeenAt across heartbeat transitions', async () => {
    const seeded = await seedFacilityGraph('camera-health');
    const adminCookie = await seedSessionCookie(
      seeded.facilityId,
      'camera-health-admin',
      Role.ADMIN,
    );

    const beforeList = await request(app.getHttpServer())
      .get('/api/v1/cameras')
      .set('cookie', adminCookie)
      .expect(200);
    expect(beforeList.body).toEqual([
      {
        id: seeded.cameraId,
        facilityId: seeded.facilityId,
        spaceId: seeded.spaceId,
        label: seeded.cameraLabel,
        lastSeenAt: null,
        online: false,
        createdAt: seeded.cameraCreatedAt.toISOString(),
      },
    ]);

    await request(app.getHttpServer())
      .post('/api/v1/events/heartbeat')
      .set('Authorization', `Bearer ${EDGE_TOKEN}`)
      .send({ camera_id: seeded.cameraId })
      .expect(200, { ok: true });

    const afterList = await request(app.getHttpServer())
      .get('/api/v1/cameras')
      .set('cookie', adminCookie)
      .expect(200);
    expect(afterList.body).toHaveLength(1);
    expect(afterList.body[0]).toEqual({
      id: seeded.cameraId,
      facilityId: seeded.facilityId,
      spaceId: seeded.spaceId,
      label: seeded.cameraLabel,
      lastSeenAt: expect.any(String),
      online: true,
      createdAt: seeded.cameraCreatedAt.toISOString(),
    });
    expect(Date.parse(afterList.body[0].lastSeenAt)).not.toBeNaN();

    const getOne = await request(app.getHttpServer())
      .get(`/api/v1/cameras/${seeded.cameraId}`)
      .set('cookie', adminCookie)
      .expect(200);
    expect(getOne.body).toEqual(afterList.body[0]);
  });

  async function seedFacilityGraph(suffix: string) {
    const facility = await direct.facility.create({
      data: {
        name: `${PREFIX}-facility-${suffix}`,
        address: `${PREFIX}-address-${suffix}`,
        phone: '010-1000-0000',
      },
    });
    const floor = await direct.floor.create({
      data: {
        facilityId: facility.id,
        name: `${PREFIX}-floor-${suffix}`,
        orderIndex: 1,
      },
    });
    const space = await direct.space.create({
      data: {
        facilityId: facility.id,
        floorId: floor.id,
        name: `${PREFIX}-space-${suffix}`,
        type: 'ROOM',
        capacity: 1,
      },
    });
    const camera = await direct.camera.create({
      data: {
        id: `${PREFIX}-camera-${suffix}`,
        facilityId: facility.id,
        spaceId: space.id,
        label: `${PREFIX}-camera-${suffix}`,
      },
    });
    return {
      facilityId: facility.id,
      facilityCreatedAt: facility.createdAt,
      spaceId: space.id,
      cameraId: camera.id,
      cameraLabel: camera.label,
      cameraCreatedAt: camera.createdAt,
    };
  }

  async function seedSessionCookie(
    facilityId: string,
    suffix: string,
    role: Role,
  ) {
    const phoneSuffix = String(
      Array.from(suffix).reduce((sum, char) => sum + char.charCodeAt(0), 0),
    ).padStart(8, '0');
    const user = await direct.user.create({
      data: {
        facilityId,
        email: `${PREFIX}-${suffix}@example.test`,
        phone: `010-${phoneSuffix.slice(0, 4)}-${phoneSuffix.slice(4)}`,
        nickname: `${PREFIX}-user-${suffix}`,
        role,
      },
    });
    const secret = app
      .get(ConfigService)
      .getOrThrow<string>('SESSION_JWT_SECRET');
    const token = sign(
      {
        sub: user.id,
        role: user.role,
        facilityId,
        sessionVersion: user.sessionVersion,
      },
      secret,
      { expiresIn: '12h' },
    );
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  async function cleanup() {
    await direct.alert.deleteMany({
      where: { facility: { name: { startsWith: PREFIX } } },
    });
    await direct.event.deleteMany({
      where: { facility: { name: { startsWith: PREFIX } } },
    });
    await direct.user.deleteMany({
      where: { nickname: { startsWith: PREFIX } },
    });
    await direct.camera.deleteMany({
      where: { label: { startsWith: PREFIX } },
    });
    await direct.space.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await direct.floor.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await direct.facility.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  }
});
