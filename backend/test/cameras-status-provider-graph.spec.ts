import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { CamerasModule } from '../src/cameras/cameras.module';
import { CamerasController } from '../src/cameras/cameras.controller';
import { CamerasService } from '../src/cameras/cameras.service';

/**
 * Provider-graph closure gate (Standing Build-Closure Rule). Compiling the new
 * modules without init() opens no DB connection; a successful compile() proves
 * the Nest dependency graph resolves the camera controller/service and
 * AuthModule-exported guards/interceptor with no unresolved tokens.
 */
describe('provider graph — cameras', () => {
  it('resolves controllers + services with Auth/Prisma deps closed', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), CamerasModule],
    }).compile();

    expect(moduleRef.get(CamerasService, { strict: false })).toBeInstanceOf(
      CamerasService,
    );
    expect(moduleRef.get(CamerasController, { strict: false })).toBeInstanceOf(
      CamerasController,
    );

    await moduleRef.close();
  });
});
