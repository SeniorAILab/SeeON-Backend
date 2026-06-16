import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AlertsModule } from '../src/alerts/alerts.module';
import { AlertWriterService } from '../src/alerts/alert-writer.service';
import { AlertsService } from '../src/alerts/alerts.service';

/**
 * Provider-graph closure gate (Standing Build-Closure Rule). A successful
 * compile() proves AlertWriterService resolves and is exported alongside the
 * existing pipeline + read-model providers with no dangling tokens.
 */
describe('provider graph — alerts module with AlertWriterService', () => {
  it('resolves and exports AlertWriterService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AlertsModule],
    }).compile();

    expect(moduleRef.get(AlertWriterService, { strict: false })).toBeInstanceOf(
      AlertWriterService,
    );
    expect(moduleRef.get(AlertsService, { strict: false })).toBeInstanceOf(
      AlertsService,
    );

    await moduleRef.close();
  });
});
