import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { DashboardModule } from '../src/dashboard/dashboard.module';
import { SseController } from '../src/dashboard/sse.controller';

/**
 * Provider-graph closure gate (Standing Build-Closure Rule). A successful
 * compile() proves SseController resolves its cross-module deps —
 * AlertWriterService + AlertsService (AlertsModule), StatusService
 * (StatusModule), SessionService (AuthModule) and the SSE_REAUTH_INTERVAL_MS
 * token — with no dangling providers and no DB connection opened.
 */
describe('provider graph — dashboard SSE module', () => {
  it('resolves SseController with all live-stream deps closed', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DashboardModule],
    }).compile();

    expect(moduleRef.get(SseController, { strict: false })).toBeInstanceOf(
      SseController,
    );

    await moduleRef.close();
  });
});
