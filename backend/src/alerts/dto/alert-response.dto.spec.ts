import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DocumentBuilder, getSchemaPath, SwaggerModule } from '@nestjs/swagger';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  AlertResponseDto,
  AlertActorDto,
  AlertDetailResponseDto,
  AlertNoteResponseDto,
  AlertSpaceDto,
  AlertSseDataDto,
  AlertUpdatedSseDataDto,
} from './alert-response.dto';

const RESPONSE_MODELS = [
  ['AlertActor', AlertActorDto],
  ['AlertSpace', AlertSpaceDto],
  ['Alert', AlertResponseDto],
  ['AlertNote', AlertNoteResponseDto],
  ['AlertDetail', AlertDetailResponseDto],
  ['AlertSseData', AlertSseDataDto],
  ['AlertUpdatedSseData', AlertUpdatedSseDataDto],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('published Alert response component metadata', () => {
  const published: unknown = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../..', 'docs/openapi/v1.json'),
      'utf8',
    ),
  );
  if (
    !isRecord(published) ||
    !isRecord(published.components) ||
    !isRecord(published.components.schemas)
  ) {
    throw new Error('Published OpenAPI document must contain a schemas record');
  }
  const publishedSchemas = published.components.schemas;
  let generated: ReturnType<typeof SwaggerModule.createDocument>;

  beforeAll(async () => {
    let moduleRef: TestingModule | undefined;
    let app: ReturnType<TestingModule['createNestApplication']> | undefined;
    try {
      moduleRef = await Test.createTestingModule({}).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      generated = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
        { extraModels: RESPONSE_MODELS.map(([, model]) => model) },
      );
      expect(generated.paths).toStrictEqual({});
      expect(
        Object.keys(generated.components?.schemas ?? {}).sort(),
      ).toStrictEqual(RESPONSE_MODELS.map(([name]) => name).sort());
    } finally {
      if (app !== undefined) await app.close();
      else if (moduleRef !== undefined) await moduleRef.close();
    }
  });

  it.each(RESPONSE_MODELS)(
    'preserves the complete %s schema',
    (name, model) => {
      expect(getSchemaPath(model)).toBe(`#/components/schemas/${name}`);
      expect(publishedSchemas[name]).toBeDefined();
      // Compare the complete JSON wire schema, including inherited properties,
      // nested references, required lists, null branches, enums and defaults.
      expect(
        JSON.parse(JSON.stringify(generated.components?.schemas?.[name])),
      ).toStrictEqual(publishedSchemas[name]);
    },
  );
});
