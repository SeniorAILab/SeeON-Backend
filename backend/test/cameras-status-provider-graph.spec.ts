import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { CamerasModule } from '../src/cameras/cameras.module';
import { CamerasController } from '../src/cameras/cameras.controller';
import { CamerasService } from '../src/cameras/cameras.service';
import { StatusModule } from '../src/status/status.module';
import { StatusController } from '../src/status/status.controller';
import { StatusService } from '../src/status/status.service';

/**
 * Provider-graph closure gate (Standing Build-Closure Rule). Compiling the new
 * modules without init() opens no DB connection; a successful compile() proves
 * the Nest dependency graph resolves every provider — including the
 * AuthModule-exported guards/interceptor — with no unresolved tokens.
 */
describe('provider graph — cameras + status', () => {
  it('resolves controllers + services with Auth/Prisma deps closed', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        CamerasModule,
        StatusModule,
      ],
    }).compile();

    expect(moduleRef.get(CamerasService, { strict: false })).toBeInstanceOf(
      CamerasService,
    );
    expect(moduleRef.get(CamerasController, { strict: false })).toBeInstanceOf(
      CamerasController,
    );
    expect(moduleRef.get(StatusService, { strict: false })).toBeInstanceOf(
      StatusService,
    );
    expect(moduleRef.get(StatusController, { strict: false })).toBeInstanceOf(
      StatusController,
    );

    await moduleRef.close();
  });
});
