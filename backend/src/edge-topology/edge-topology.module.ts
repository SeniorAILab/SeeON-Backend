import { Module } from '@nestjs/common';
import { EdgeFacilityTokenGuard } from '../cameras/edge-facility-token.guard.js';
import { EdgeCredentialsModule } from '../edge-credentials/edge-credentials.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EdgeTopologyConfirmationRepository } from './edge-topology-confirmation.repository.js';
import { EdgeTopologyController } from './edge-topology.controller.js';
import { EdgeTopologyRepository } from './edge-topology.repository.js';
import { EdgeTopologyService } from './edge-topology.service.js';

@Module({
  imports: [PrismaModule, EdgeCredentialsModule],
  controllers: [EdgeTopologyController],
  providers: [
    EdgeFacilityTokenGuard,
    EdgeTopologyRepository,
    EdgeTopologyConfirmationRepository,
    EdgeTopologyService,
  ],
})
export class EdgeTopologyModule {}
