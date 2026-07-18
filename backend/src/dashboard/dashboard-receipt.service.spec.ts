import { DashboardReceiptKind, Prisma } from '@prisma/client';
import { FacilityScopedNotFoundException } from '../common/domain-errors.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { DashboardReceiptService } from './dashboard-receipt.service.js';

const baseInput = {
  facilityId: 'facility-1',
  dashboardClientId: 'dashboard-client-1',
  backendEventId: 'event-1',
  alertId: 'alert-1',
  alertSeq: '42',
  observedAt: '2026-07-17T03:00:00.000Z',
};

function receipt(kind: DashboardReceiptKind, id: string) {
  return {
    id,
    facilityId: baseInput.facilityId,
    dashboardClientId: baseInput.dashboardClientId,
    kind,
    backendEventId: baseInput.backendEventId,
    alertId: baseInput.alertId,
    alertSeq: 42n,
    surface:
      kind === DashboardReceiptKind.DELIVERY
        ? 'normalized-feed'
        : 'monitor-room-board:focus',
    observedAt: new Date(baseInput.observedAt),
    createdAt: new Date('2026-07-17T03:00:01.000Z'),
  };
}

describe('DashboardReceiptService', () => {
  const alertFindFirst = jest.fn();
  const receiptCreate = jest.fn();
  const receiptFindFirst = jest.fn();
  const tx = {
    alert: { findFirst: alertFindFirst },
    dashboardReceipt: {
      create: receiptCreate,
      findFirst: receiptFindFirst,
    },
  };
  const prisma = {
    withFacilityContext: jest.fn(
      (_facilityId: string, callback: (client: typeof tx) => unknown) =>
        callback(tx),
    ),
  };
  const service = new DashboardReceiptService(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    alertFindFirst.mockResolvedValue({ id: baseInput.alertId });
    receiptFindFirst.mockResolvedValue(null);
  });

  it('returns the persisted delivery id after validating alert-event correlation', async () => {
    receiptCreate.mockResolvedValue(
      receipt(DashboardReceiptKind.DELIVERY, 'delivery-1'),
    );

    await expect(service.recordDelivery(baseInput)).resolves.toMatchObject({
      deliveryId: 'delivery-1',
      backendEventId: 'event-1',
      alertId: 'alert-1',
      alertSeq: '42',
      kind: 'delivery',
      surface: 'normalized-feed',
      duplicate: false,
    });
    expect(alertFindFirst.mock.calls).toEqual([
      [
        {
          where: {
            id: 'alert-1',
            facilityId: 'facility-1',
            alertSeq: 42n,
            originEventId: 'event-1',
          },
          select: { id: true },
        },
      ],
    ]);
  });

  it('returns the original presentation id for an idempotent duplicate', async () => {
    receiptFindFirst.mockResolvedValue(
      receipt(DashboardReceiptKind.PRESENTATION, 'presentation-1'),
    );

    await expect(
      service.recordPresentation({
        ...baseInput,
        surface: 'monitor-room-board:focus',
      }),
    ).resolves.toMatchObject({
      presentationId: 'presentation-1',
      kind: 'presentation',
      duplicate: true,
    });
    expect(prisma.withFacilityContext).toHaveBeenCalledTimes(1);
    expect(receiptCreate).not.toHaveBeenCalled();
    expect(receiptFindFirst.mock.calls).toEqual([
      [
        {
          where: {
            facilityId: 'facility-1',
            dashboardClientId: 'dashboard-client-1',
            kind: DashboardReceiptKind.PRESENTATION,
            alertId: 'alert-1',
            alertSeq: 42n,
            surface: 'monitor-room-board:focus',
          },
        },
      ],
    ]);
  });

  it('recovers the winning row when a concurrent insert races past the duplicate check', async () => {
    receiptFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue(receipt(DashboardReceiptKind.DELIVERY, 'delivery-1'));
    receiptCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(service.recordDelivery(baseInput)).resolves.toMatchObject({
      deliveryId: 'delivery-1',
      kind: 'delivery',
      duplicate: true,
    });
    expect(prisma.withFacilityContext).toHaveBeenCalledTimes(2);
  });

  it('does not create a receipt for an uncorrelated client claim', async () => {
    alertFindFirst.mockResolvedValue(null);

    await expect(service.recordDelivery(baseInput)).rejects.toBeInstanceOf(
      FacilityScopedNotFoundException,
    );
    expect(receiptCreate).not.toHaveBeenCalled();
  });
});
