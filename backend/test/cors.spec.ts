import { Controller, Get, Header, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureFrontendCors } from '../src/config/frontend-cors.js';

const PRODUCT_ORIGIN = 'https://seeon.seniorsailab.com';
const LEGACY_ORIGIN = 'http://49.247.204.81';
const ALLOWED_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'];

@Controller()
class CorsProbeController {
  @Get('probe')
  probe(): { ok: true } {
    return { ok: true };
  }

  @Get('stream')
  @Header('content-type', 'text/event-stream')
  stream(): string {
    return 'event: heartbeat\ndata: {}\n\n';
  }
}

describe('credentialed frontend CORS (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CorsProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureFrontendCors(app, {
      NODE_ENV: 'production',
      FRONT_ORIGINS: `${PRODUCT_ORIGIN},${LEGACY_ORIGIN}`,
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([PRODUCT_ORIGIN, LEGACY_ORIGIN])(
    'echoes the exact allowed origin for OPTIONS and GET: %s',
    async (origin) => {
      const preflight = await request(app.getHttpServer())
        .options('/probe')
        .set('origin', origin)
        .set('access-control-request-method', 'GET')
        .set('access-control-request-headers', 'content-type,x-facility-id')
        .expect(204);

      expect(preflight.headers['access-control-allow-origin']).toBe(origin);
      expect(preflight.headers['access-control-allow-credentials']).toBe(
        'true',
      );
      expect(splitHeader(preflight.headers.vary)).toContain('Origin');
      expect(
        splitHeader(preflight.headers['access-control-allow-methods']),
      ).toEqual(expect.arrayContaining(ALLOWED_METHODS));
      expect(
        splitHeader(preflight.headers['access-control-allow-headers']).map(
          (header) => header.toLowerCase(),
        ),
      ).toEqual(expect.arrayContaining(['content-type', 'x-facility-id']));

      const get = await request(app.getHttpServer())
        .get('/probe')
        .set('origin', origin)
        .expect(200, { ok: true });
      expect(get.headers['access-control-allow-origin']).toBe(origin);
      expect(get.headers['access-control-allow-credentials']).toBe('true');
      expect(splitHeader(get.headers.vary)).toContain('Origin');
    },
  );

  it('allows no-Origin Edge and health-style processing without CORS headers', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe')
      .expect(200, { ok: true });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    'https://evil.example',
    'https://seeon.seniorsailab.com.evil.example',
    'https://prefix-seeon.seniorsailab.com',
    'http://seeon.seniorsailab.com',
    `${PRODUCT_ORIGIN}/path`,
  ])('omits ACAO for non-exact origin %s', async (origin) => {
    const response = await request(app.getHttpServer())
      .get('/probe')
      .set('origin', origin)
      .expect(200, { ok: true });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('adds credentialed CORS headers to an SSE GET', async () => {
    const response = await request(app.getHttpServer())
      .get('/stream')
      .set('origin', PRODUCT_ORIGIN)
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['access-control-allow-origin']).toBe(
      PRODUCT_ORIGIN,
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});

function splitHeader(value: string | undefined): string[] {
  return value?.split(',').map((part) => part.trim()) ?? [];
}
