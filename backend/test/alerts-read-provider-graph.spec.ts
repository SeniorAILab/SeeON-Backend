import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AlertsModule } from '../src/alerts/alerts.module';
import { AlertsController } from '../src/alerts/alerts.controller';
import { AlertsService } from '../src/alerts/alerts.service';
import { AlertEventsService } from '../src/alerts/services/alert-events.service';

/**
 * Provider-graph closure gate (Standing Build-Closure Rule). Compiling the
 * reconciled AlertsModule without init() opens no DB connection; a successful
 * compile() proves the #105 read-model providers/controllers AND the retained
 * outbox fan-out seam co-resolve in one module with no dangling tokens.
 *
 * The legacy /api.alerts/events AlertEventsController and /ingest/alerts surface
 * were removed; /api/v1/events is the only live ML ingress. AlertEventsService
 * is retained for the persisted outbox + email fan-out seam.
 */
describe('provider graph — alerts module (read-model + outbox seam)', () => {
  it('resolves the read AlertsController/Service and the retained AlertEventsService seam', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AlertsModule],
    }).compile();

    expect(moduleRef.get(AlertsService, { strict: false })).toBeInstanceOf(
      AlertsService,
    );
    expect(moduleRef.get(AlertsController, { strict: false })).toBeInstanceOf(
      AlertsController,
    );

    const alertEvents = moduleRef.get(AlertEventsService, { strict: false });
    expect(alertEvents).toBeInstanceOf(AlertEventsService);

    await moduleRef.close();
  });
});
