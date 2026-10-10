import type { INestApplication } from '@nestjs/common';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import { configureHttpBodyParsing } from './http-body-parsing.adapter.js';
import { StrictJsonError } from '../errors/strict-json.error.js';

const ENROLLMENT = '/api/v1/edge/enrollments/verify';
const TOPOLOGY = '/api/v1/edge/topology-snapshots/snapshot-1';
const DUPLICATE = '{"value":1,"value":2}';
const INVALID_SCHEMA = {
  schemaVersion: 1,
  error: {
    code: 'INVALID_SCHEMA',
    message: 'Request does not match edge provisioning v1.',
    retryable: false,
    requestId: 'strict-json',
  },
};

function setup(injectedError?: Error) {
  const app = express();
  const received: { body: unknown; rawBody: unknown }[] = [];
  const forwarded: unknown[] = [];
  if (injectedError !== undefined) {
    app.use((_req, _res, next) => next(injectedError));
  }
  // This integration only needs use(); no Nest application or providers are built.
  configureHttpBodyParsing(app as unknown as INestApplication);
  app.use((req: Request, res: Response) => {
    const body: unknown = req.body;
    received.push({
      body,
      rawBody: 'rawBody' in req ? req.rawBody : undefined,
    });
    res.status(200).json({ accepted: true });
  });
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      // Express identifies error handlers by their four-argument arity.
      void _next;
      forwarded.push(error);
      res.status(422).json({ forwarded: true });
    },
  );
  return { app, received, forwarded };
}

describe('configureHttpBodyParsing isolated Express integration', () => {
  it.each([
    { method: 'post', path: ENROLLMENT, strict: true },
    { method: 'post', path: `${ENROLLMENT}?next=/ordinary`, strict: true },
    { method: 'put', path: ENROLLMENT, strict: false },
    { method: 'post', path: `${ENROLLMENT}/`, strict: false },
    { method: 'post', path: '/api/v1/admin/edge-installations', strict: true },
    {
      method: 'patch',
      path: '/api/v1/admin/edge-installations',
      strict: false,
    },
    { method: 'post', path: '/api/v1/admin/edges', strict: false },
    { method: 'put', path: TOPOLOGY, strict: true },
    { method: 'patch', path: `${TOPOLOGY}/confirm?x=1`, strict: true },
    { method: 'post', path: `${TOPOLOGY}/confirm/extra`, strict: false },
    { method: 'post', path: `${TOPOLOGY}/`, strict: false },
    { method: 'post', path: `/ordinary?next=${ENROLLMENT}`, strict: false },
  ])(
    'preserves route/method/query boundaries: $method $path',
    async ({ method, path, strict }) => {
      const f = setup();
      const client = request(f.app);
      const call =
        method === 'put'
          ? client.put(path)
          : method === 'patch'
            ? client.patch(path)
            : client.post(path);
      await call
        .set('Content-Type', 'application/json')
        .send(DUPLICATE)
        .expect(strict ? 400 : 200)
        .expect(strict ? INVALID_SCHEMA : { accepted: true });
      expect(f.forwarded).toEqual([]);
      if (strict) {
        expect(f.received).toEqual([]);
      } else {
        expect(f.received).toEqual([
          { body: { value: 2 }, rawBody: undefined },
        ]);
      }
    },
  );

  it.each([ENROLLMENT, '/ordinary'])(
    'captures exact raw UTF-8 bytes only for strict requests: %s',
    async (path) => {
      const f = setup();
      const body = ' { "label": "한글", "number": 1 }\n';
      await request(f.app)
        .post(path)
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);
      const received = f.received.at(0);
      if (received === undefined) throw new Error('Request was not observed');
      expect(received.body).toEqual({ label: '한글', number: 1 });
      if (path === ENROLLMENT) {
        expect(Buffer.isBuffer(received.rawBody)).toBe(true);
        expect(received.rawBody).toEqual(Buffer.from(body));
      } else {
        expect(received.rawBody).toBeUndefined();
      }
      expect(f.forwarded).toEqual([]);
    },
  );

  it('forwards an ordinary malformed JSON error rather than emitting the strict schema envelope', async () => {
    const f = setup();
    await request(f.app)
      .post('/ordinary')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(422)
      .expect({ forwarded: true });
    expect(f.received).toEqual([]);
    expect(f.forwarded).toHaveLength(1);
    expect(f.forwarded.at(0)).toBeInstanceOf(SyntaxError);
    expect(f.forwarded.at(0)).not.toBeInstanceOf(StrictJsonError);
  });

  it('maps strict malformed JSON to the exact 400 response without forwarding', async () => {
    const f = setup();
    await request(f.app)
      .post(ENROLLMENT)
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400)
      .expect(INVALID_SCHEMA);
    expect(f.received).toEqual([]);
    expect(f.forwarded).toEqual([]);
  });

  it('passes a non-StrictJsonError to the next error handler with original identity', async () => {
    const failure = new Error('earlier middleware failure');
    const f = setup(failure);
    await request(f.app)
      .post(ENROLLMENT)
      .send({ value: 1 })
      .expect(422)
      .expect({ forwarded: true });
    expect(f.forwarded).toHaveLength(1);
    expect(f.forwarded.at(0)).toBe(failure);
    expect(f.received).toEqual([]);
  });
});
