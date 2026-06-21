import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

/** AC9: ingest payload missing required contract field. */
export class MissingFieldException extends BadRequestException {
  constructor(field: string) {
    super({
      error: 'MISSING_FIELD',
      field,
      message: `Field '${field}' is required`,
    });
  }
}

/** AC9: ingest HMAC signature invalid. */
export class InvalidSignatureException extends UnauthorizedException {
  constructor() {
    super({
      error: 'INVALID_SIGNATURE',
      message: 'HMAC signature mismatch or missing',
    });
  }
}

/** AC9: ingest timestamp too old (freshness window). */
export class StaleTimestampException extends BadRequestException {
  constructor() {
    super({
      error: 'STALE_TIMESTAMP',
      message: 'detected_at or X-Ingest-Timestamp outside freshness window',
    });
  }
}

/** AC9: ingest camera not found for the given key-id. */
export class UnknownIngestKeyException extends UnauthorizedException {
  constructor() {
    super({
      error: 'UNKNOWN_INGEST_KEY',
      message: 'No camera found for the provided X-Ingest-Key-Id',
    });
  }
}

/** AC9: ingest payload facility_id or resident_id does not match camera's facility. */
export class TenantMismatchException extends ForbiddenException {
  constructor(reason: string) {
    super({ error: 'TENANT_MISMATCH', message: reason });
  }
}

/** F12: cross-tenant resource exists but not visible to caller. */
export class FacilityScopedNotFoundException extends NotFoundException {
  constructor(resource: string) {
    super({ error: 'NOT_FOUND', resource });
  }
}
