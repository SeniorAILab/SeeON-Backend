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
 * outbox/prediction seam co-resolve in one module with no dangling tokens.
 *
 * The legacy /api.alerts/events AlertEventsController was removed (ADR-047
 * single-ingress cleanup); /ingest/alerts is the only live alert ingress.
 * AlertEventsService is retained for ensureOutboxForIngest + the D2-O1 future
 * prediction seam (ADR-048), so it must still resolve with its prediction port.
 */
describe('provider graph — alerts module (read-model + outbox/prediction seam)', () => {
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
    // D2-O1: the prediction seam stays wired even though no live route consumes it.
    expect(alertEvents.predictionSeam()).toBeDefined();

    await moduleRef.close();
  });
});
