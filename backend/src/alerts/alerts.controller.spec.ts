import { ForbiddenException } from '@nestjs/common';
import type { RequestWithAuth } from '../auth/session.guard';
import type { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';

function setup() {
  const ack = jest.fn().mockResolvedValue({ id: 'a1', status: 'ACKED' });
  const resolve = jest.fn().mockResolvedValue({ id: 'a1', status: 'RESOLVED' });
  const service = { ack, resolve } as unknown as AlertsService;
  return { controller: new AlertsController(service), ack, resolve };
}

function req(user: Record<string, unknown> | undefined): RequestWithAuth {
  return { user } as unknown as RequestWithAuth;
}

describe('AlertsController lifecycle routes', () => {
  it('ack passes the session facility + actor id (never a body actor)', async () => {
    const { controller, ack } = setup();
    const result = await controller.ack(
      req({ id: 'user-1', facilityId: 'facility-1' }),
      'a1',
    );
    expect(ack).toHaveBeenCalledWith('facility-1', 'a1', 'user-1');
    expect(result).toMatchObject({ status: 'ACKED' });
  });

  it('resolve passes the session facility + actor id', async () => {
    const { controller, resolve } = setup();
    const result = await controller.resolve(
      req({ id: 'user-2', facilityId: 'facility-1' }),
      'a1',
    );
    expect(resolve).toHaveBeenCalledWith('facility-1', 'a1', 'user-2');
    expect(result).toMatchObject({ status: 'RESOLVED' });
  });

  it('rejects when the session has no facility context', () => {
    const { controller } = setup();
    expect(() => controller.ack(req({ id: 'user-1' }), 'a1')).toThrow(
      ForbiddenException,
    );
  });

  it('rejects when the session has no user id', () => {
    const { controller } = setup();
    expect(() =>
      controller.resolve(req({ facilityId: 'facility-1' }), 'a1'),
    ).toThrow(ForbiddenException);
  });
});
