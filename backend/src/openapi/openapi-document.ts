import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALERT_LIST_PATH = '/api/v1/alerts';

export function createOpenApiDocument(
  app: INestApplication,
  title = 'Eldercare backend API',
): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle(title)
    .addCookieAuth('app_session')
    .build();
  const generated = SwaggerModule.createDocument(app, config);
  const document = mergePublishedContract(generated);
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

function mergePublishedContract(generated: OpenAPIObject): OpenAPIObject {
  const path = publishedContractPath();
  if (path === null) return generated;
  const published = JSON.parse(readFileSync(path, 'utf8')) as OpenAPIObject;
  return {
    ...published,
    paths: { ...generated.paths, ...published.paths },
    components: {
      ...generated.components,
      ...published.components,
      schemas: {
        ...generated.components?.schemas,
        ...published.components?.schemas,
      },
    },
  };
}

function publishedContractPath(): string | null {
  for (const candidate of [
    join(process.cwd(), 'docs', 'openapi', 'v1.json'),
    join(process.cwd(), '..', 'docs', 'openapi', 'v1.json'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
