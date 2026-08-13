import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';

const ALERT_LIST_PATH = '/api/v1/alerts';

export function createOpenApiDocument(
  app: INestApplication,
  title = 'Eldercare backend API',
): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle(title)
    .addCookieAuth('app_session')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const listPath = asRecord(
    (document.paths as Record<string, unknown>)[ALERT_LIST_PATH],
  );
  const listOperation = asRecord(listPath?.get);
  const responses = asRecord(listOperation?.responses);
  const listResponse = asRecord(responses?.['200']);
  if (listResponse === undefined) return document;

  const schemas = (document.components ??= {}).schemas ?? {};
  document.components.schemas = schemas;
  schemas.AlertList = {
    type: 'array',
    items: { $ref: '#/components/schemas/Alert' },
  };
  listResponse.content = {
    'application/json': {
      schema: { $ref: '#/components/schemas/AlertList' },
    },
  };
  return document;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
