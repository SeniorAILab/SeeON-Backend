import type { INestApplication } from '@nestjs/common';
import { json, type NextFunction, type Request, type Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { StrictJsonError } from '../errors/strict-json.error.js';
import { parseStrictJson } from '../helpers/strict-json-reader.helper.js';

type StrictJsonRequest = IncomingMessage & { rawBody?: Buffer };

export function configureHttpBodyParsing(app: INestApplication): void {
  app.use(
    json({
      verify(request, _response, bytes) {
        if (!isStrictRoute(request.method ?? '', request.url ?? '')) return;
        const parsed = parseStrictJson(bytes);
        const strictRequest: StrictJsonRequest = request;
        strictRequest.rawBody = parsed.originalBytes;
      },
    }),
  );
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ): void => {
      if (!(error instanceof StrictJsonError)) {
        next(error);
        return;
      }
      response.status(400).json({
        schemaVersion: 1,
        error: {
          code: 'INVALID_SCHEMA',
          message: 'Request does not match edge provisioning v1.',
          retryable: false,
          requestId: 'strict-json',
        },
      });
    },
  );
}

function isStrictRoute(method: string, originalUrl: string): boolean {
  const path = originalUrl.split('?', 1)[0];
  if (method === 'POST' && path === '/api/v1/edge/enrollments/verify')
    return true;
  if (/^\/api\/v1\/edge\/topology-snapshots\/[^/]+(?:\/confirm)?$/.test(path))
    return true;
  return method === 'POST' && /^\/api\/v1\/admin\/edge-/.test(path);
}
