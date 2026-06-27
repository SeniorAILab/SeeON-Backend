import { RequestMethod, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  if (process.env.FRONT_ORIGIN) {
    app.enableCors({ origin: process.env.FRONT_ORIGIN, credentials: true });
  }
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
  // ponytail: routes/methods auto-discovered from controllers; no per-route decorators.
  // Add @ApiProperty on a DTO only when its request/response shape needs to show in the schema.
  const config = new DocumentBuilder()
    .setTitle('Eldercare backend API')
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, config),
  );
  await app.listen(process.env.PORT ?? 8080);
}
bootstrap().catch((error: unknown) => {
  console.error('Bootstrap failed', error);
  process.exit(1);
});
