import { RequestMethod, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureHttpBodyParsing } from './common/json/strict-json-parser.js';
import { configureFrontendCors } from './config/frontend-cors.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureHttpBodyParsing(app);
  configureFrontendCors(app);
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
  // whitelist/forbidNonWhitelisted intentionally left off: unknown body fields
  // stay tolerated, matching pre-migration manual-parsing behavior.
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  // ponytail: routes/methods auto-discovered from controllers; no per-route decorators.
  // Add @ApiProperty on a DTO only when its request/response shape needs to show in the schema.
  const config = new DocumentBuilder()
    .setTitle('Eldercare backend API')
    .addCookieAuth('app_session')
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
