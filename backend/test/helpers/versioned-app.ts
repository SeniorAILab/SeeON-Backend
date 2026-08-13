import type { INestApplication } from '@nestjs/common';
import { RequestMethod, ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { createOpenApiDocument } from '../../src/openapi/openapi-document';

export function configureVersionedTestApp(app: INestApplication): void {
  app.setGlobalPrefix('api', {
    exclude: [
      { path: '/', method: RequestMethod.ALL },
      { path: '/health', method: RequestMethod.ALL },
    ],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  SwaggerModule.setup('api/docs', app, createOpenApiDocument(app));
}
