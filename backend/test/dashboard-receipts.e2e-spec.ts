import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard.js';
import { DashboardReceiptController } from '../src/dashboard/dashboard-receipt.controller.js';
import { DashboardReceiptService } from '../src/dashboard/dashboard-receipt.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { configureVersionedTestApp } from './helpers/versioned-app.js';

interface ReceiptBody {
  deliveryId?: string;
  presentationId?: string;
  backendEventId: string;
  alertId: string;
  alertSeq: string;
  duplicate: boolean;
}

describe('dashboard receipts (e2e)', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const facilityId = `receipt-facility-${suffix}`;
  const floorId = `receipt-floor-${suffix}`;
  const spaceId = `receipt-space-${suffix}`;
  const cameraId = `receipt-camera-${suffix}`;
  const eventId = `receipt-event-${suffix}`;
  const alertId = `receipt-alert-${suffix}`;
  const direct = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let app: INestApplication;
  let alertSeq: string;

  beforeAll(async () => {
    await direct.$connect();
    await direct.facility.create({
      data: { id: facilityId, name: 'Receipt QA' },
    });
    await direct.floor.create({
      data: {
        id: floorId,
        facilityId,
        name: '1F',
        orderIndex: 1,
      },
    });
    await direct.space.create({
      data: {
        id: spaceId,
        facilityId,
        floorId,
        name: '101',
        type: 'ROOM',
        capacity: 1,
      },
    });
    await direct.camera.create({
      data: {
        id: cameraId,
        facilityId,
        spaceId,
        label: `camera-${suffix}`,
      },
    });
    await direct.event.create({
      data: {
        id: eventId,
        facilityId,
        cameraId,
        spaceId,
        type: 'bed-exit',
        confidence: 0.94,
        detectedAt: new Date('2026-07-17T03:00:00.000Z'),
        dedupKey: `event-${suffix}`,
      },
    });
    const alert = await direct.alert.create({
      data: {
        id: alertId,
        facilityId,
        cameraId,
        spaceId,
        type: 'bed-exit',
        probability: 0.94,
        detectedAt: new Date('2026-07-17T03:00:00.000Z'),
        idempotencyKey: `alert-${suffix}`,
        originEventId: eventId,
      },
    });
    alertSeq = alert.alertSeq.toString();

    const module = await Test.createTestingModule({
      imports: [PrismaModule],
      controllers: [DashboardReceiptController],
      providers: [DashboardReceiptService],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest<{
            user?: Record<string, unknown>;
          }>();
          req.user = {
            id: 'receipt-user',
            facilityId,
            role: 'STAFF',
            sessionVersion: 0,
          };
          return true;
        },
      } satisfies CanActivate)
      .compile();
    app = module.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await direct.dashboardReceipt.deleteMany({ where: { facilityId } });
    await direct.alert.deleteMany({ where: { facilityId } });
    await direct.event.deleteMany({ where: { facilityId } });
    await direct.camera.deleteMany({ where: { facilityId } });
    await direct.space.deleteMany({ where: { facilityId } });
    await direct.floor.deleteMany({ where: { facilityId } });
    await direct.facility.delete({ where: { id: facilityId } });
    await direct.$disconnect();
  });

  it('persists separate idempotent feed and DOM receipt ids over HTTP', async () => {
    const common = {
      dashboardClientId: `client-${suffix}`,
      backendEventId: eventId,
      alertId,
      alertSeq,
      observedAt: '2026-07-17T03:00:05.000Z',
    };
    const firstResponse = await request(httpServer(app))
      .post('/api/v1/dashboard/receipts/delivery')
      .send(common)
      .expect(201);
    const duplicateResponse = await request(httpServer(app))
      .post('/api/v1/dashboard/receipts/delivery')
      .send(common)
      .expect(201);
    const presentationResponse = await request(httpServer(app))
      .post('/api/v1/dashboard/receipts/presentation')
      .send({ ...common, surface: 'monitor-room-board:focus' })
      .expect(201);

    const first = receiptBody(firstResponse.body as unknown);
    const duplicate = receiptBody(duplicateResponse.body as unknown);
    const presentation = receiptBody(presentationResponse.body as unknown);
    expect(first.deliveryId).toBeTruthy();
    expect(duplicate).toMatchObject({
      deliveryId: first.deliveryId,
      duplicate: true,
    });
    expect(presentation.presentationId).toBeTruthy();
    expect(presentation.presentationId).not.toBe(first.deliveryId);
    await expect(
      direct.dashboardReceipt.count({ where: { facilityId } }),
    ).resolves.toBe(2);
  });

  it('rejects an uncorrelated backend event id without a receipt', async () => {
    await request(httpServer(app))
      .post('/api/v1/dashboard/receipts/delivery')
      .send({
        dashboardClientId: `client-invalid-${suffix}`,
        backendEventId: `wrong-${eventId}`,
        alertId,
        alertSeq,
        observedAt: '2026-07-17T03:00:05.000Z',
      })
      .expect(404);
    await expect(
      direct.dashboardReceipt.count({ where: { facilityId } }),
    ).resolves.toBe(2);
  });
});

function receiptBody(value: unknown): ReceiptBody {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid receipt response');
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.backendEventId !== 'string' ||
    typeof body.alertId !== 'string' ||
    typeof body.alertSeq !== 'string' ||
    typeof body.duplicate !== 'boolean'
  ) {
    throw new Error('Invalid receipt response');
  }
  return body as unknown as ReceiptBody;
}

function httpServer(app: INestApplication): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}
