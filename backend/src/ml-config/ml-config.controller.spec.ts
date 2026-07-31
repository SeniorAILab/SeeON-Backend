import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
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
});
