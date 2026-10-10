import { Module } from '@nestjs/common';
import { EdgeFacilityTokenGuard } from '../cameras/guards/edge-facility-token.guard.js';
import { EdgeCredentialsModule } from '../edge-credentials/edge-credentials.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EdgeTopologyConfirmationRepository } from './repositories/edge-topology-confirmation.repository.js';
import { EdgeTopologyController } from './controllers/edge-topology.controller.js';
import { EdgeTopologyRepository } from './repositories/edge-topology.repository.js';
import { EdgeTopologyService } from './services/edge-topology.service.js';

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
