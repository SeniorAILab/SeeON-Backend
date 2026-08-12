import type { INestApplication } from '@nestjs/common';
import { parseFrontendOrigins } from './frontend-origins.js';

const CORS_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'] as const;
const CORS_ALLOWED_HEADERS = ['content-type', 'x-facility-id'] as const;

export function configureFrontendCors(
  app: INestApplication,
  config: Record<string, unknown> = process.env,
): void {
  const allowedOrigins = new Set(parseFrontendOrigins(config));

  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) {
      callback(null, origin === undefined || allowedOrigins.has(origin));
    },
    credentials: true,
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
  });
}
