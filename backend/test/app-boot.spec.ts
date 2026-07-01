import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureVersionedTestApp } from './helpers/versioned-app';

/**
 * Boot + wiring smoke (real DB, full AppModule — no provider overrides).
 *
 * Catches the wiring/serialization bug class that mocked unit tests structurally
 * cannot, both of which actually reached main during the #105 decomposition:
 *  - AppModule fails to boot — a dangling provider or unregistered module (e.g.
 *    AuthModule was once never registered, 404'ing every /api/v1/auth/* route).
 *  - guarded domain/auth routes must be MOUNTED: unauthenticated requests get
 *    401, NOT 404. A 404 here means the owning module isn't registered.
 *  - Alert.alertSeq (BigInt) must serialize in JSON responses via the global
 *    toJSON shim installed on AppModule load; without it /api/v1/alerts 500s.
 */
describe('AppModule boot + wiring smoke (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots the full provider graph (no dangling / unregistered modules)', () => {
    expect(app).toBeDefined();
  });

  it.each([
    '/api/v1/auth/session',
    '/api/v1/alerts',
    '/api/v1/residents',
    '/api/v1/guardians',
    '/api/v1/cameras',
  ])('mounts guarded route %s (401, not 404)', async (path) => {
    const server = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];
    const res = await request(server).get(path);
    expect(res.status).toBe(401);
  });

  it('serializes BigInt (Alert.alertSeq) in JSON instead of throwing', () => {
    expect(() => JSON.stringify({ alertSeq: 1n })).not.toThrow();
    const parsed = JSON.parse(JSON.stringify({ alertSeq: 7n })) as {
      alertSeq: string;
    };
    expect(parsed.alertSeq).toBe('7');
  });
});
