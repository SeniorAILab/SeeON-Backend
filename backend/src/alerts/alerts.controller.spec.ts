import { ForbiddenException } from '@nestjs/common';
import type { RequestWithAuth } from '../auth/jwt-auth.guard';
import type { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';

function setup() {
  const resolve = jest.fn().mockResolvedValue({ id: 'a1', status: 'RESOLVED' });
  const addNote = jest.fn().mockResolvedValue({ id: 'n1', note: 'checked' });
  const service = { resolve, addNote } as unknown as AlertsService;
  return { controller: new AlertsController(service), resolve, addNote };
}

function req(user: Record<string, unknown> | undefined): RequestWithAuth {
  return { user } as unknown as RequestWithAuth;
}

describe('AlertsController lifecycle routes', () => {
  it('resolve passes the session facility + actor id', async () => {
    const { controller, resolve } = setup();
    const result = await controller.resolve(
      req({ id: 'user-2', facilityId: 'facility-1' }),
      'a1',
    );
    expect(resolve).toHaveBeenCalledWith('facility-1', 'a1', 'user-2');
    expect(result).toMatchObject({ status: 'RESOLVED' });
  });

  it('addNote passes facility, actor id, and role snapshot', async () => {
    const { controller, addNote } = setup();
    const result = await controller.addNote(
      req({ id: 'user-2', facilityId: 'facility-1', role: 'STAFF' }),
      'a1',
      { note: 'checked' },
    );
    expect(addNote).toHaveBeenCalledWith({
      facilityId: 'facility-1',
      alertId: 'a1',
      note: 'checked',
      actorUserId: 'user-2',
      actorRole: 'STAFF',
    });
    expect(result).toMatchObject({ note: 'checked' });
  });

  it('rejects when the session has no facility context', () => {
    const { controller } = setup();
    expect(() => controller.resolve(req({ id: 'user-1' }), 'a1')).toThrow(
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
