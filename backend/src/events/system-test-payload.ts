import { BadRequestException } from '@nestjs/common';
import type { RecordEventRequestDto } from './dto/event.dto.js';
import { SYSTEM_TEST_MODE } from './system-test.constants.js';

const SYSTEM_TEST_WIRE_FIELDS = new Set([
  'type',
  'test_mode',
  'detected_at',
  'edge_event_id',
  'validation_run_id',
]);

export function isSystemTestWireRequest(body: RecordEventRequestDto): boolean {
  return body.type === SYSTEM_TEST_MODE || body.test_mode !== undefined;
}

export function assertSystemTestWirePayload(body: RecordEventRequestDto): void {
  if (body.type !== SYSTEM_TEST_MODE || body.test_mode !== SYSTEM_TEST_MODE) {
    throw new BadRequestException(
      'SYSTEM_TEST requires exact type and test_mode sentinels',
    );
  }
  if (
    body.edge_event_id === undefined ||
    body.validation_run_id === undefined
  ) {
    throw new BadRequestException(
      'SYSTEM_TEST requires edge_event_id and validation_run_id',
    );
  }
  const forbidden = Object.entries(body).filter(
    ([field, value]) =>
      value !== undefined && !SYSTEM_TEST_WIRE_FIELDS.has(field),
  );
  if (forbidden.length > 0) {
    throw new BadRequestException(
      'SYSTEM_TEST accepts no camera, room, resident, person, or media fields',
    );
  }
}
