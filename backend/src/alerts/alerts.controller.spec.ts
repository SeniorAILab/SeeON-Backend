import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, RequireFacilityGuard } from '../auth/jwt-auth.guard';
import { readArray } from '../../test/helpers/json-response';
import type { RequestWithAuth } from '../auth/jwt-auth.guard';
import type { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';

function setup() {
  const resolve = jest.fn().mockResolvedValue({ id: 'a1', status: 'RESOLVED' });
  const ack = jest.fn().mockResolvedValue({ id: 'a1', status: 'ACKED' });
  const addNote = jest.fn().mockResolvedValue({ id: 'n1', note: 'checked' });
  const service = { resolve, ack, addNote } as unknown as AlertsService;
  return { controller: new AlertsController(service), resolve, ack, addNote };
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

describe('AlertsController ack route protection', () => {
  it('컨트롤러 전체가 JWT + 시설 가드 뒤에 있다', () => {
    // ack는 메서드 레벨 가드가 없다. 클래스 레벨 보호가 사라지면 새 라우트가
    // 무방비로 노출되므로 여기서 고정한다.
    const guards = readArray(
      Reflect.getMetadata(GUARDS_METADATA, AlertsController),
      'AlertsController guards',
    );
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(RequireFacilityGuard);
  });

  it('ack는 세션 시설로 스코프된다', async () => {
    const { controller, ack } = setup();

    await controller.ack(
      { effectiveFacilityId: 'facility-1', user: { id: 'user-1' } } as never,
      'alert-1',
    );

    expect(ack).toHaveBeenCalledWith('facility-1', 'alert-1', 'user-1');
  });

  it('시설 컨텍스트가 없으면 ack가 거부된다', () => {
    const { controller, ack } = setup();

    expect(() =>
      controller.ack({ user: { id: 'user-1' } } as never, 'alert-1'),
    ).toThrow(ForbiddenException);
    expect(ack).not.toHaveBeenCalled();
  });
});
