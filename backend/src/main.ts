import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  if (process.env.FRONT_ORIGIN) {
    app.enableCors({ origin: process.env.FRONT_ORIGIN, credentials: true });
  }
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
