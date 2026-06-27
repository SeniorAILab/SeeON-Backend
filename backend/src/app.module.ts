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
import { IngestModule } from './ingest/ingest.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { FacilitiesModule } from './facilities/facilities.module.js';
import { FloorsModule } from './floors/floors.module.js';
import { SpacesModule } from './spaces/spaces.module.js';
import { ZonesModule } from './zones/zones.module.js';
import { ResidentAssignmentsModule } from './resident-assignments/resident-assignments.module.js';
import { SpaceStatusesModule } from './space-statuses/space-statuses.module.js';
import { ResidentRiskSummariesModule } from './resident-risk-summaries/resident-risk-summaries.module.js';
import { EventsModule } from './events/events.module.js';
import { backendEnvFilePaths } from './config/env-files.js';
import { validateBackendEnv } from './config/env-validation.js';

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
    ResidentsModule,
    GuardiansModule,
    CamerasModule,
    StatusModule,
    AlertsModule,
    IngestModule,
    DashboardModule,
    FacilitiesModule,
    FloorsModule,
    SpacesModule,
    ZonesModule,
    ResidentAssignmentsModule,
    SpaceStatusesModule,
    ResidentRiskSummariesModule,
    EventsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
