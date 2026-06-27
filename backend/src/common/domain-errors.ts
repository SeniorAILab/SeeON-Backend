import { NotFoundException } from '@nestjs/common';

/** F12: cross-tenant resource exists but not visible to caller. */
export class FacilityScopedNotFoundException extends NotFoundException {
  constructor(resource: string) {
    super({ error: 'NOT_FOUND', resource });
  }
}
