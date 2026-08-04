import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { hasRbacCapability } from '../auth/auth.constants.js';
import {
  REQUIRED_CAPABILITY_METADATA_KEY,
  RolesGuard,
} from '../auth/roles.guard.js';
import { EdgeIngestTokenGuard } from '../events/edge-ingest-token.guard.js';
import { readArray } from '../../test/helpers/json-response.js';
import { MlConfigController } from './ml-config.controller.js';
import type { MlConfigService } from './ml-config.service.js';

const payload = {
  configVersion: 3,
  nightWindow: { start: '21:00', end: '07:00', tz: 'Asia/Seoul' },
  cameras: [
    {
      id: 'camera-1',
      spaceId: 'space-1',
      label: 'Room 1',
      rtspUrl: 'rtsp://camera.local/live',
      online: true,
      spaceName: 'Room 101',
      floorName: '1F',
      createdAt: '2026-07-10T12:34:56.789Z',
    },
  ],
};

describe('MlConfigController', () => {
  it('GET returns additive camera metadata while preserving the legacy camera fields', async () => {
    const getConfig = jest.fn().mockResolvedValue(payload);
    const service = { getConfig } as unknown as jest.Mocked<MlConfigService>;
    const controller = new MlConfigController(service);

    await expect(controller.getConfig('facility-1')).resolves.toEqual(payload);
    expect(getConfig).toHaveBeenCalledWith('facility-1');
  });

  it('GET is guarded by the shared edge bearer token because the payload carries RTSP URLs', () => {
    const getConfig: unknown = Object.getOwnPropertyDescriptor(
      MlConfigController.prototype,
      'getConfig',
    )?.value;
    if (typeof getConfig !== 'function') {
      throw new Error('MlConfigController.getConfig is not a method');
    }
    const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, getConfig);

    expect(readArray(guards, 'getConfig guards')).toContain(
      EdgeIngestTokenGuard,
    );
  });

  it('night-window PUT rejects authenticated facility mismatch', () => {
    const updateNightWindow = jest.fn();
    const service = {
      updateNightWindow,
    } as unknown as jest.Mocked<MlConfigService>;
    const controller = new MlConfigController(service);

    expect(() =>
      controller.updateNightWindow(
        { effectiveFacilityId: 'facility-1' } as never,
        'facility-2',
        { start: '21:00', end: '07:00', tz: 'Asia/Seoul' },
      ),
    ).toThrow(ForbiddenException);
    expect(updateNightWindow).not.toHaveBeenCalled();
  });

  it('night-window PUT requires facilityAdmin so STAFF cannot change detection policy', () => {
    const updateNightWindow = jest.fn();
    const service = {
      updateNightWindow,
    } as unknown as jest.Mocked<MlConfigService>;
    const controller = new MlConfigController(service);
    const handler = (controller as unknown as Record<string, unknown>)
      .updateNightWindow;
    if (typeof handler !== 'function') {
      throw new Error('MlConfigController.updateNightWindow is not a method');
    }

    const guards = readArray(
      Reflect.getMetadata(GUARDS_METADATA, handler),
      'updateNightWindow guards',
    );
    expect(guards).toContain(RolesGuard);

    // facilityAdmin capability는 ADMIN 이상에만 있고 STAFF에는 없다.
    const capability: unknown = Reflect.getMetadata(
      REQUIRED_CAPABILITY_METADATA_KEY,
      handler,
    );
    expect(capability).toBe('facilityAdmin');
    expect(hasRbacCapability('ADMIN', 'facilityAdmin')).toBe(true);
    expect(hasRbacCapability('SUPER_ADMIN', 'facilityAdmin')).toBe(true);
    expect(hasRbacCapability('STAFF', 'facilityAdmin')).toBe(false);
  });

  it('edge config GET stays on the shared-token guard and is not role-restricted', () => {
    const getConfig = jest.fn();
    const service = { getConfig } as unknown as jest.Mocked<MlConfigService>;
    const controller = new MlConfigController(service);
    const handler = (controller as unknown as Record<string, unknown>)
      .getConfig;
    if (typeof handler !== 'function') {
      throw new Error('MlConfigController.getConfig is not a method');
    }

    const guards = readArray(
      Reflect.getMetadata(GUARDS_METADATA, handler),
      'getConfig guards',
    );
    // 엣지 워커 pull 경로는 사용자 JWT가 아니라 공유 토큰으로 붙는다.
    expect(guards).toContain(EdgeIngestTokenGuard);
    expect(guards).not.toContain(RolesGuard);
  });

  it('엣지 pull은 GET이므로 야간정책 쓰기 제한에 영향받지 않는다', () => {
    // 엣지 lifespan.py는 ml-config를 GET으로만 읽는다. PUT :facilityId/night-window에
    // RolesGuard를 걸어도 엣지 config pull이 끊기지 않는 근거다.
    const controller = new MlConfigController({
      getConfig: jest.fn(),
    } as unknown as jest.Mocked<MlConfigService>);
    const getHandler = (controller as unknown as Record<string, unknown>)
      .getConfig;
    const putHandler = (controller as unknown as Record<string, unknown>)
      .updateNightWindow;
    if (typeof getHandler !== 'function' || typeof putHandler !== 'function') {
      throw new Error('MlConfigController handlers missing');
    }

    // 읽기와 쓰기가 서로 다른 가드 집합을 가진다 — 하나가 다른 하나를 막지 않는다.
    const getGuards = readArray(
      Reflect.getMetadata(GUARDS_METADATA, getHandler),
      'getConfig guards',
    );
    const putGuards = readArray(
      Reflect.getMetadata(GUARDS_METADATA, putHandler),
      'updateNightWindow guards',
    );

    expect(getGuards).toContain(EdgeIngestTokenGuard);
    expect(putGuards).not.toContain(EdgeIngestTokenGuard);
    expect(putGuards).toContain(RolesGuard);
    expect(getGuards).not.toContain(RolesGuard);
  });
});
