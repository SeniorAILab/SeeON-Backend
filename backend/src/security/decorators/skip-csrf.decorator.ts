import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF_METADATA_KEY = 'seeon:skip-csrf';

export const SkipCsrf = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_CSRF_METADATA_KEY, true);
