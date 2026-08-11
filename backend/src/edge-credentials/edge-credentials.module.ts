import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EdgeAdminRepository } from './edge-admin.repository.js';
import { EdgeAdminService } from './edge-admin.service.js';
import { EDGE_CLOCK, SystemEdgeClock } from './edge-clock.js';
import { EdgeCredentialAuthenticator } from './edge-credential-authenticator.js';
import { EdgeCredentialQueryRepository } from './edge-credential-query.repository.js';
import { EdgeCredentialService } from './edge-credential.service.js';
import { EdgeMutationSupport } from './edge-mutation-support.js';
import {
  EdgeCredentialAdminController,
  EdgeEnrollmentController,
  EdgeOperationAdminController,
} from './edge-credential.controller.js';
import { EdgeInstallationAdminController } from './edge-installation.controller.js';
import { EdgeIssuanceRepository } from './edge-issuance.repository.js';
import { EdgeLifecycleRepository } from './edge-lifecycle.repository.js';
import { EdgeReplacementRepository } from './edge-replacement.repository.js';
import { EnrollmentRateLimiter } from './enrollment-rate-limiter.js';
import { LegacyEdgeMetrics } from './legacy-edge-metrics.js';
import { SuperAdminEdgeGuard } from './super-admin-edge.guard.js';

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
    EdgeCredentialAuthenticator,
    EdgeMutationSupport,
    EdgeCredentialService,
    EdgeAdminService,
    EnrollmentRateLimiter,
    LegacyEdgeMetrics,
    SuperAdminEdgeGuard,
  ],
  exports: [EdgeCredentialAuthenticator, LegacyEdgeMetrics, EdgeAdminService],
})
export class EdgeCredentialsModule {}
