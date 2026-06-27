import { INestApplication, RequestMethod, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureVersionedTestApp(app: INestApplication): void {
  app.setGlobalPrefix('api', {
    exclude: [
      { path: '/', method: RequestMethod.ALL },
      { path: 'auth/(.*)', method: RequestMethod.ALL },
      { path: 'ingest/(.*)', method: RequestMethod.ALL },
    ],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Eldercare backend API')
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );
}
