import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AlertsModule } from '../src/alerts/alerts.module';
import { AlertsController } from '../src/alerts/alerts.controller';
import { AlertsService } from '../src/alerts/alerts.service';
import { AlertEventsController } from '../src/alerts/controllers/alert-events.controller';

/**
 * Provider-graph closure gate (Standing Build-Closure Rule). Compiling the
 * reconciled AlertsModule without init() opens no DB connection; a successful
 * compile() proves both the #103 ingestion pipeline AND the #105 read-model
 * providers/controllers co-resolve in one module with no dangling tokens.
 */
describe('provider graph — alerts module (pipeline + read-model)', () => {
  it('resolves both AlertEventsController and the read AlertsController/Service', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AlertsModule],
    }).compile();

    expect(moduleRef.get(AlertsService, { strict: false })).toBeInstanceOf(
      AlertsService,
    );
    expect(moduleRef.get(AlertsController, { strict: false })).toBeInstanceOf(
      AlertsController,
    );
    expect(
      moduleRef.get(AlertEventsController, { strict: false }),
    ).toBeInstanceOf(AlertEventsController);

    await moduleRef.close();
  });
});
