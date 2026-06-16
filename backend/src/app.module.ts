import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AlertsModule } from './alerts/alerts.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ResidentsModule } from './residents/residents.module.js';
import { GuardiansModule } from './guardians/guardians.module.js';
import { CamerasModule } from './cameras/cameras.module.js';
import { StatusModule } from './status/status.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env.${process.env.NODE_ENV ?? 'development'}`,
    }),
    PrismaModule,
    AuthModule,
    ResidentsModule,
    GuardiansModule,
    CamerasModule,
    StatusModule,
    AlertsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
