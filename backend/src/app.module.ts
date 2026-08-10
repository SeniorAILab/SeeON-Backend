import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AlertsModule } from './alerts/alerts.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CamerasModule } from './cameras/cameras.module.js';

import { DashboardModule } from './dashboard/dashboard.module.js';
import { FacilitiesModule } from './facilities/facilities.module.js';
import { FloorsModule } from './floors/floors.module.js';
import { SpacesModule } from './spaces/spaces.module.js';
import { EventsModule } from './events/events.module.js';
import { UsersModule } from './users/users.module.js';
import { backendEnvFilePaths } from './config/env-files.js';
import { MlConfigModule } from './ml-config/ml-config.module.js';
import { validateBackendEnv } from './config/env-validation.js';
import { EventMediaModule } from './media/event-media.module.js';
import { AlertMediaModule } from './media/alert-media.module.js';
import { EdgeCredentialsModule } from './edge-credentials/edge-credentials.module.js';

// Ensure BigInt fields (e.g. Alert.alertSeq, exposed by the alerts read API
// and the SSE stream) serialize in JSON responses. Nest uses JSON.stringify,
// which throws on BigInt without this prototype shim.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (
  this: bigint,
): string {
  return this.toString();
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: backendEnvFilePaths(),
      validate: validateBackendEnv,
    }),
    PrismaModule,
    AuthModule,
    EdgeCredentialsModule,
    CamerasModule,
    AlertsModule,
    DashboardModule,
    FacilitiesModule,
    FloorsModule,
    SpacesModule,
    EventsModule,
    MlConfigModule,
    UsersModule,
    EventMediaModule,
    AlertMediaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
