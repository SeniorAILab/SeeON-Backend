import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { EdgeMediaCapabilityQueryDto } from './edge-media-capability-query.dto.js';
import { ReportUnavailableClipRequestDto } from './report-unavailable-clip-request.dto.js';

describe('edge media DTO validation contract', () => {
  const pipe = new ValidationPipe({ transform: true });
  const queryMetadata = {
    type: 'query' as const,
    metatype: EdgeMediaCapabilityQueryDto,
  };
  const requestMetadata = {
    type: 'body' as const,
    metatype: ReportUnavailableClipRequestDto,
  };
  const validRequest = {
    camera_id: 'camera-1',
    event_refs: ['event-1', 'event-2'],
    state_version: 1,
    reason: 'CAPTURE_FAILED',
  };

  it('preserves an empty query camera ID and extra fields', async () => {
    const input = { camera_id: '', extra: 'retained' };
    const result: unknown = await pipe.transform(input, queryMetadata);

    expect(result).toBeInstanceOf(EdgeMediaCapabilityQueryDto);
    expect(result).toEqual(input);
  });

  it.each([42, false, [], {}, null, undefined])(
    'rejects a non-string query camera ID: %p',
    async (camera_id) => {
      await expect(
        pipe.transform({ camera_id }, queryMetadata),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  describe.each(['CAPTURE_FAILED', 'QUEUE_FULL', 'CORRUPT', 'UPLOAD_TIMEOUT'])(
    'request reason %s',
    (reason) => {
      it.each([1, 2_147_483_647])(
        'accepts state version boundary %p',
        async (state_version) => {
          const input = { ...validRequest, reason, state_version };
          const result: unknown = await pipe.transform(input, requestMetadata);

          expect(result).toBeInstanceOf(ReportUnavailableClipRequestDto);
          expect(result).toEqual(input);
        },
      );
    },
  );

  it('retains request extras and permits blank string IDs', async () => {
    const input = {
      ...validRequest,
      camera_id: '',
      event_refs: [''],
      extra: { retained: true },
    };
    const result: unknown = await pipe.transform(input, requestMetadata);

    expect(result).toBeInstanceOf(ReportUnavailableClipRequestDto);
    expect(result).toEqual(input);
  });

  it.each([
    { event_refs: [] },
    { event_refs: ['event-1', 'event-1'] },
    { event_refs: ['event-1', 42] },
    { event_refs: 'event-1' },
    { state_version: 0 },
    { state_version: 2_147_483_648 },
    { state_version: 1.5 },
    { state_version: '1' },
    { camera_id: 42 },
    { reason: 'UNKNOWN' },
  ])('rejects invalid request values: %p', async (invalid) => {
    await expect(
      pipe.transform({ ...validRequest, ...invalid }, requestMetadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe.each(['camera_id', 'event_refs', 'state_version', 'reason'])(
    'required request field %s',
    (field) => {
      it.each([null, undefined])('rejects %p', async (value) => {
        await expect(
          pipe.transform({ ...validRequest, [field]: value }, requestMetadata),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    },
  );
});
