import { ForbiddenException } from '@nestjs/common';
import type { RequestWithAuth } from '../auth/jwt-auth.guard.js';
import { DashboardReceiptController } from './dashboard-receipt.controller.js';
import type { DashboardReceiptService } from './dashboard-receipt.service.js';

function requestWithFacility(facilityId: string | undefined): RequestWithAuth {
  return {
    user: facilityId
      ? {
          id: 'user-1',
          facilityId,
          role: 'STAFF',
          sessionVersion: 0,
        }
      : undefined,
  } as unknown as RequestWithAuth;
}

describe('DashboardReceiptController', () => {
  const recordDelivery = jest.fn();
  const recordPresentation = jest.fn();
  const controller = new DashboardReceiptController({
    recordDelivery,
    recordPresentation,
  } as unknown as DashboardReceiptService);

  beforeEach(() => jest.clearAllMocks());

  it('uses authenticated facility context and returns the delivery id', async () => {
    recordDelivery.mockResolvedValue({ deliveryId: 'delivery-1' });
    const body = {
      dashboardClientId: 'client-1',
      backendEventId: 'event-1',
      alertId: 'alert-1',
      alertSeq: '42',
      observedAt: '2026-07-17T03:00:00.000Z',
    };

    await expect(
      controller.recordDelivery(requestWithFacility('facility-1'), body),
    ).resolves.toEqual({ deliveryId: 'delivery-1' });
    expect(recordDelivery).toHaveBeenCalledWith({
      facilityId: 'facility-1',
      ...body,
    });
  });

  it('returns the presentation id from the dedicated presentation path', async () => {
    recordPresentation.mockResolvedValue({
      presentationId: 'presentation-1',
    });
    const body = {
      dashboardClientId: 'client-1',
      backendEventId: 'event-1',
      alertId: 'alert-1',
      alertSeq: '42',
      observedAt: '2026-07-17T03:00:00.000Z',
      surface: 'monitor-room-board:focus',
    };

    await expect(
      controller.recordPresentation(requestWithFacility('facility-1'), body),
    ).resolves.toEqual({ presentationId: 'presentation-1' });
  });

  it('rejects receipt creation without facility context', () => {
    expect(() =>
      controller.recordDelivery(requestWithFacility(undefined), {
        dashboardClientId: 'client-1',
        backendEventId: 'event-1',
        alertId: 'alert-1',
        alertSeq: '42',
        observedAt: '2026-07-17T03:00:00.000Z',
      }),
    ).toThrow(ForbiddenException);
  });
});
