import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthModule } from '../src/auth/auth.module.js';
import {
  JwtAuthGuard,
  type RequestWithAuth,
} from '../src/auth/jwt-auth.guard.js';
import type { CamerasService } from '../src/cameras/cameras.service.js';
import {
  EDGE_CLOCK,
  type EdgeClock,
} from '../src/edge-credentials/edge-clock.js';
import { EdgeCredentialsModule } from '../src/edge-credentials/edge-credentials.module.js';
import { EventRecorderService } from '../src/events/event-recorder.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { sha256CanonicalJson } from './helpers/edge-contract-fixtures.js';
import {
  readObject,
  readObjectField,
  readStringField,
} from './helpers/json-response.js';

const FACILITY_ID = 'a5ff4ed1-7e63-4a4f-9ef0-42e807d74a64';
const OTHER_FACILITY_ID = 'b5ff4ed1-7e63-4a4f-9ef0-42e807d74a64';
const CAMERA_ID = 'b3333333-3333-4333-8333-333333333333';
const SPACE_ID = 'a2222222-2222-4222-8222-222222222222';
const FLOOR_ID = 'f1111111-1111-4111-8111-111111111111';

class FakeClock implements EdgeClock {
  private current = new Date('2026-01-01T00:00:00.000Z');
  now(): Date {
    return new Date(this.current);
  }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class SuperAdminSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    req.user = {
      id: 'task-9-super-admin',
      facilityId: null,
      role: Role.SUPER_ADMIN,
      email: 'task-9@example.invalid',
      nickname: 'Task 9',
      sessionVersion: 1,
    };
    return true;
  }
}

describe('edge enrollment v1 contract', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let clock: FakeClock;
  let sequence = 0;

  beforeAll(async () => {
    clock = new FakeClock();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        AuthModule,
        EdgeCredentialsModule,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(SuperAdminSessionGuard)
      .overrideProvider(EDGE_CLOCK)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    prisma = moduleRef.get(PrismaService);
    admin = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
    await admin.$connect();
    await cleanup();
    await seedFacilities();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await admin.$disconnect();
  });

  it('issues one-time credential material but persists only its digest and prefix', async () => {
    const issued = await issue();
    expect(issued.facilityCode).toMatch(/^NH-[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(issued.token).toMatch(
      /^eft_v1\.[0-9A-HJKMNP-TV-Z]{12}\.[A-Za-z0-9_-]{43}$/,
    );
    const persisted = await admin.edgeCredential.findUniqueOrThrow({
      where: { tokenId: issued.tokenId },
    });
    expect(persisted.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(issued.token);
  });

  it('claims a pending installation by CAS, replays exactly, and rejects a different ref', async () => {
    const issued = await issue();
    const clientRef = uuidV4();
    const first = await verify(issued, clientRef).expect(200);
    const replay = await verify(issued, clientRef).expect(200);
    expect(replay.body).toEqual(first.body);
    await verify(issued, uuidV4())
      .expect(409)
      .expect(({ body }) =>
        expect(
          readStringField(
            readObjectField(readObject(body, 'conflict'), 'error'),
            'code',
          ),
        ).toBe('INSTALLATION_CONFLICT'),
      );
  });

  it('rotates with an exact fake-clock 24-hour grace and preserves binding', async () => {
    const issued = await issue();
    const ref = uuidV4();
    await verify(issued, ref).expect(200);
    const rotated = await mutate(
      `/api/v1/admin/edge-credentials/${issued.tokenId}/rotate`,
      {
        schemaVersion: 1,
        expectedLifecycle: 'ACTIVE',
      },
    ).expect(201);
    const rotatedBody = readObject(rotated.body, 'rotate response');
    expect(readStringField(rotatedBody, 'edgeInstallationId')).toBe(
      issued.edgeInstallationId,
    );
    expect(rotatedBody.enrollmentGeneration).toBe(1);
    expect(
      readStringField(readObjectField(rotatedBody, 'prior'), 'graceEndsAt'),
    ).toBe('2026-01-02T00:00:00.000Z');
    await verify(issued, ref).expect(200);
    clock.advance(24 * 60 * 60 * 1000);
    await verify(issued, ref).expect(403);
  });

  it('revokes immediately and redacts list responses', async () => {
    const issued = await issue();
    await mutate(`/api/v1/admin/edge-credentials/${issued.tokenId}/revoke`, {
      schemaVersion: 1,
      expectedLifecycle: 'ACTIVE',
      reason: 'ADMIN_REVOKED',
    }).expect(200);
    await verify(issued, uuidV4()).expect(403);
    const listed = await request(app.getHttpServer())
      .get(`/api/v1/admin/edge-credentials?facilityId=${FACILITY_ID}`)
      .expect(200);
    const listedBody = readObject(listed.body, 'list response');
    expect(JSON.stringify(listedBody)).not.toMatch(
      /eft_v1\.[^.]+\.[A-Za-z0-9_-]{43}/,
    );
    const items = listedBody.items;
    if (!Array.isArray(items)) throw new Error('list items must be array');
    expect(
      items.every((item) => {
        const row = readObject(item, 'list item');
        return row.valueState === 'not-returned';
      }),
    ).toBe(true);
  });

  it('replaces an installation generation and makes prior tokens stale', async () => {
    const issued = await issue();
    await verify(issued, uuidV4()).expect(200);
    const replacement = await mutate(
      `/api/v1/admin/edge-installations/${issued.edgeInstallationId}/replace`,
      {
        schemaVersion: 1,
        expectedEnrollmentGeneration: 1,
        newClientInstallationRef: uuidV4(),
      },
    ).expect(201);
    expect(readObject(replacement.body, 'replace').enrollmentGeneration).toBe(
      2,
    );
    await verify(issued, uuidV4()).expect(403);
  });

  it('recovers a lost secret once by revoking it without grace', async () => {
    const issued = await issue();
    const recovered = await mutate(
      `/api/v1/admin/edge-operations/${issued.operationId}/recover-secret`,
      {
        schemaVersion: 1,
        expectedTokenId: issued.tokenId,
      },
    ).expect(201);
    const recoveredBody = readObject(recovered.body, 'recover response');
    expect(readStringField(recoveredBody, 'revokedTokenId')).toBe(
      issued.tokenId,
    );
    expect(
      readStringField(
        readObjectField(recoveredBody, 'oneTimeDisplay'),
        'value',
      ),
    ).toMatch(/^eft_v1\./);
    await verify(issued, uuidV4()).expect(403);
  });

  it('replays an idempotent issue redacted and rejects a changed body', async () => {
    const key = uuidV7();
    const first = await mutateWithKey(
      '/api/v1/admin/edge-credentials',
      { schemaVersion: 1, facilityId: FACILITY_ID },
      key,
    ).expect(201);
    const replay = await mutateWithKey(
      '/api/v1/admin/edge-credentials',
      { schemaVersion: 1, facilityId: FACILITY_ID },
      key,
    ).expect(201);
    const firstBody = readObject(first.body, 'issue first');
    const replayBody = readObject(replay.body, 'issue replay');
    expect(readStringField(replayBody, 'secretDisplay')).toBe('NOT_AVAILABLE');
    expect(JSON.stringify(replayBody)).not.toContain(
      readStringField(readObjectField(firstBody, 'oneTimeDisplay'), 'value'),
    );
    await mutateWithKey(
      '/api/v1/admin/edge-credentials',
      { schemaVersion: 1, facilityId: OTHER_FACILITY_ID },
      key,
    ).expect(409);
  });

  it('applies an exact persisted ownership-transfer manifest', async () => {
    const issued = await issue();
    await verify(issued, uuidV4()).expect(200);
    const manifest = [
      {
        kind: 'FLOOR',
        edgeRef: 'floor-2',
        canonicalId: FLOOR_ID,
        parentCanonicalId: null,
      },
      {
        kind: 'ROOM',
        edgeRef: 'room-201',
        canonicalId: SPACE_ID,
        parentCanonicalId: FLOOR_ID,
      },
      {
        kind: 'CAMERA',
        edgeRef: 'camera-001',
        canonicalId: CAMERA_ID,
        parentCanonicalId: SPACE_ID,
      },
    ] as const;
    await admin.edgeTopologyAlias.createMany({
      data: manifest.map((item) => ({
        facilityId: FACILITY_ID,
        edgeInstallationId: issued.edgeInstallationId,
        enrollmentGeneration: 1,
        ...item,
      })),
    });
    const response = await mutate(
      `/api/v1/admin/edge-installations/${issued.edgeInstallationId}/transfers`,
      {
        schemaVersion: 1,
        expectedEnrollmentGeneration: 1,
        expectedServerRevision: 0,
        manifestDigest: sha256CanonicalJson(manifest),
        manifest,
      },
    ).expect(201);
    expect(
      readObjectField(readObject(response.body, 'transfer'), 'transferred'),
    ).toEqual({
      floors: 1,
      rooms: 1,
      cameras: 1,
    });
    expect(
      (await admin.camera.findUniqueOrThrow({ where: { id: CAMERA_ID } }))
        .provisioningSource,
    ).toBe('EDGE');
  });

  it('creates an active validation grant and excludes its event from ordinary lists', async () => {
    const issued = await issue();
    await verify(issued, uuidV4()).expect(200);
    const grant = await mutate(
      `/api/v1/admin/edge-installations/${issued.edgeInstallationId}/validation-runs`,
      {
        schemaVersion: 1,
        expectedEnrollmentGeneration: 1,
        durationSeconds: 900,
      },
    ).expect(201);
    const cameras = {
      resolveForEventIngest: jest.fn().mockResolvedValue({
        id: CAMERA_ID,
        facilityId: FACILITY_ID,
        spaceId: SPACE_ID,
      }),
    };
    const recorder = new EventRecorderService(
      prisma,
      cameras as unknown as CamerasService,
    );
    const validationRunId = readStringField(
      readObject(grant.body, 'validation grant'),
      'validationRunId',
    );
    const recorded = await recorder.record({
      cameraId: CAMERA_ID,
      facilityId: FACILITY_ID,
      validationRunId,
      type: 'fall',
      detectedAt: new Date('2026-01-01T00:01:00.000Z'),
      edgeEventId: uuidV4(),
    });
    expect(recorded.event.validationRunId).toBe(validationRunId);
    expect((await recorder.list(FACILITY_ID)).items).toHaveLength(0);
  });

  it('limits verify to five attempts per source IP and twenty per facility code', async () => {
    clock.advance(60 * 60 * 1000);
    const issued = await issue();
    for (let attempt = 0; attempt < 5; attempt += 1)
      await invalidVerify(issued.facilityCode, '198.51.100.7').expect(401);
    await invalidVerify(issued.facilityCode, '198.51.100.7').expect(429);
    for (let attempt = 0; attempt < 14; attempt += 1)
      await invalidVerify(
        issued.facilityCode,
        `198.51.100.${attempt + 20}`,
      ).expect(401);
    await invalidVerify(issued.facilityCode, '198.51.100.99').expect(429);
  });

  async function issue() {
    const response = await mutate('/api/v1/admin/edge-credentials', {
      schemaVersion: 1,
      facilityId: FACILITY_ID,
    }).expect(201);
    const body = readObject(response.body, 'issue response');
    const oneTime = readObjectField(body, 'oneTimeDisplay');
    return {
      operationId: readStringField(body, 'operationId'),
      facilityCode: readStringField(body, 'facilityCode'),
      edgeInstallationId: readStringField(body, 'edgeInstallationId'),
      tokenId: readStringField(oneTime, 'tokenId'),
      token: readStringField(oneTime, 'value'),
    };
  }

  function mutate(path: string, body: object) {
    return request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', uuidV7())
      .send(body);
  }

  function mutateWithKey(path: string, body: object, key: string) {
    return request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', key)
      .send(body);
  }

  function verify(issued: Awaited<ReturnType<typeof issue>>, ref: string) {
    return request(app.getHttpServer())
      .post('/api/v1/edge/enrollments/verify')
      .set('X-Forwarded-For', uuidV4())
      .set('Authorization', `Bearer ${issued.token}`)
      .send({
        schemaVersion: 1,
        facilityCode: issued.facilityCode,
        clientInstallationRef: ref,
      });
  }

  function invalidVerify(facilityCode: string, ip: string) {
    return request(app.getHttpServer())
      .post('/api/v1/edge/enrollments/verify')
      .set('X-Forwarded-For', ip)
      .set('Authorization', 'Bearer invalid')
      .send({
        schemaVersion: 1,
        facilityCode,
        clientInstallationRef: uuidV4(),
      });
  }

  function uuidV7(): string {
    sequence += 1;
    return `0197f671-3a31-7a6c-a6e4-${sequence.toString(16).padStart(12, '0')}`;
  }
  function uuidV4(): string {
    sequence += 1;
    return `8b0f5ba2-d359-4d8e-948f-${sequence.toString(16).padStart(12, '0')}`;
  }

  async function seedFacilities(): Promise<void> {
    await admin.facility.createMany({
      data: [
        { id: FACILITY_ID, name: 'Test Facility' },
        { id: OTHER_FACILITY_ID, name: 'Other Facility' },
      ],
    });
    await admin.floor.create({
      data: {
        id: FLOOR_ID,
        facilityId: FACILITY_ID,
        name: '2F',
        orderIndex: 2,
      },
    });
    await admin.space.create({
      data: {
        id: SPACE_ID,
        facilityId: FACILITY_ID,
        floorId: FLOOR_ID,
        name: 'Room',
        type: 'ROOM',
        capacity: 1,
      },
    });
    await admin.camera.create({
      data: {
        id: CAMERA_ID,
        facilityId: FACILITY_ID,
        label: 'Camera',
        spaceId: SPACE_ID,
      },
    });
  }

  async function cleanup(): Promise<void> {
    await admin.event.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.edgeProvisioningAudit.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.edgeValidationGrant.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.edgeOwnershipTransfer.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.edgeTopologyAlias.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.edgeCredential.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.edgeAdminOperation.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.camera.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.space.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.floor.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.edgeInstallation.deleteMany({
      where: { facilityId: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
    await admin.facility.deleteMany({
      where: { id: { in: [FACILITY_ID, OTHER_FACILITY_ID] } },
    });
  }
});
