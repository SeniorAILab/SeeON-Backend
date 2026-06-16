import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  if (process.env.FRONT_ORIGIN) {
    app.enableCors({ origin: process.env.FRONT_ORIGIN, credentials: true });
  }
  await app.listen(process.env.PORT ?? 8080);
}
bootstrap().catch((error: unknown) => {
  console.error('Bootstrap failed', error);
  process.exit(1);
});
