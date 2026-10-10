import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EdgeAdminRepository } from './repositories/edge-admin.repository.js';
import { EdgeAdminService } from './services/edge-admin.service.js';
import { EDGE_CLOCK } from './edge-clock.js';
import { SystemEdgeClock } from './adapters/system-edge-clock.adapter.js';
import { EdgeCredentialAuthenticatorService } from './services/edge-credential-authenticator.service.js';
import { EdgeCredentialQueryRepository } from './repositories/edge-credential-query.repository.js';
import { EdgeCredentialService } from './services/edge-credential.service.js';
import { EdgeMutationSupportService } from './services/edge-mutation-support.service.js';
import {
  EdgeCredentialAdminController,
  EdgeEnrollmentController,
  EdgeOperationAdminController,
} from './controllers/edge-credential.controller.js';
import { EdgeInstallationAdminController } from './controllers/edge-installation.controller.js';
import { EdgeEnrollmentGuard } from './guards/edge-enrollment.guard.js';
import { EdgeIssuanceRepository } from './repositories/edge-issuance.repository.js';
import { EdgeLifecycleRepository } from './repositories/edge-lifecycle.repository.js';
import { EdgeReplacementRepository } from './repositories/edge-replacement.repository.js';
import { EnrollmentRateLimiterService } from './services/enrollment-rate-limiter.service.js';
import { LegacyEdgeMetricsService } from './services/legacy-edge-metrics.service.js';
import { SuperAdminEdgeGuard } from './guards/super-admin-edge.guard.js';

@Global()
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    EdgeCredentialAdminController,
    EdgeOperationAdminController,
    EdgeEnrollmentController,
    EdgeInstallationAdminController,
  ],
  providers: [
    { provide: EDGE_CLOCK, useClass: SystemEdgeClock },
    EdgeCredentialQueryRepository,
    EdgeIssuanceRepository,
    EdgeLifecycleRepository,
    EdgeReplacementRepository,
    EdgeAdminRepository,
    EdgeCredentialAuthenticatorService,
    EdgeMutationSupportService,
    EdgeCredentialService,
    EdgeAdminService,
    EnrollmentRateLimiterService,
    EdgeEnrollmentGuard,
    LegacyEdgeMetricsService,
    SuperAdminEdgeGuard,
  ],
  exports: [
    EdgeCredentialAuthenticatorService,
    LegacyEdgeMetricsService,
    EdgeAdminService,
  ],
})
export class EdgeCredentialsModule {}
