import { ForbiddenException } from '@nestjs/common';
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
    },
  ],
};

describe('MlConfigController', () => {
  it('GET returns service payload without requiring a request guard context', async () => {
    const service = {
      getConfig: jest.fn().mockResolvedValue(payload),
    } as unknown as jest.Mocked<MlConfigService>;
    const controller = new MlConfigController(service);

    await expect(controller.getConfig('facility-1')).resolves.toEqual(payload);
    expect(service.getConfig).toHaveBeenCalledWith('facility-1');
  });

  it('night-window PUT rejects authenticated facility mismatch', () => {
    const service = {
      updateNightWindow: jest.fn(),
    } as unknown as jest.Mocked<MlConfigService>;
    const controller = new MlConfigController(service);

    expect(() =>
      controller.updateNightWindow(
        { effectiveFacilityId: 'facility-1' } as never,
        'facility-2',
        { start: '21:00', end: '07:00', tz: 'Asia/Seoul' },
      ),
    ).toThrow(ForbiddenException);
    expect(service.updateNightWindow).not.toHaveBeenCalled();
  });
});
