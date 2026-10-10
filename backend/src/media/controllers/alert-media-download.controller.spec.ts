import { UnauthorizedException } from '@nestjs/common';
import type { FileHandle } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import type { Response } from 'express';
import type { RequestWithAuth } from '../../auth/guards/jwt-auth.guard.js';
import { AlertMediaService } from '../services/alert-media.service.js';
import type { AlertMediaRepository } from '../repositories/alert-media.repository.js';
import { AlertMediaDownloadController } from './alert-media-download.controller.js';

const ETAG = `"sha256-${'a'.repeat(64)}"`;

function setup(headers: Record<string, string> = {}) {
  const events: string[] = [];
  const body = Buffer.from([0, 255, 13, 10]);
  const chunks: Buffer[] = [];
  const stream = Readable.from([body]);
  const capability = {
    createReadStream: jest.fn<
      Readable,
      [Parameters<FileHandle['createReadStream']>[0]]
    >(() => {
      events.push('create');
      return stream;
    }),
    close: jest.fn(() => {
      events.push('close');
      return Promise.resolve();
    }),
  };
  const handle = capability as unknown as FileHandle;
  const media = {
    handle,
    clipId: 'clip-1',
    sizeBytes: body.length,
    sha256: 'a'.repeat(64),
    readyAt: new Date('2026-07-06T00:00:00.000Z'),
  };
  const service = new AlertMediaService({} as AlertMediaRepository);
  const open = jest.spyOn(service, 'openContent').mockImplementation(() => {
    events.push('open');
    return Promise.resolve(media);
  });
  const create = jest.spyOn(service, 'createContentReadStream');
  const close = jest.spyOn(service, 'closeContent');
  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      events.push('write');
      chunks.push(chunk);
      callback();
    },
  });
  const setHeader = jest.fn((name: string, value: string) => {
    events.push(`header:${name}`);
    return value;
  });
  const status = jest.fn((code: number): Writable => {
    events.push(`status:${code}`);
    return writable;
  });
  const response = Object.assign(writable, {
    setHeader,
    status,
    headersSent: false,
  });
  const end = jest.spyOn(response, 'end');
  const request = {
    effectiveFacilityId: 'facility-1',
    headers,
  } as unknown as RequestWithAuth;
  return {
    controller: new AlertMediaDownloadController(service),
    request,
    response: response as unknown as Response,
    events,
    body,
    chunks,
    stream,
    handle,
    capability,
    media,
    open,
    create,
    close,
    setHeader,
    status,
    end,
  };
}

describe('AlertMediaDownloadController capability lifecycle', () => {
  it('opens before attachment headers and pipes identical bytes/stream before closing once', async () => {
    const f = setup();
    await expect(
      f.controller.getDownload(f.request, 'alert-1', f.response),
    ).resolves.toBeUndefined();
    expect(f.open).toHaveBeenCalledWith('facility-1', 'alert-1');
    expect(f.create).toHaveBeenCalledWith(f.handle, {
      start: 0,
      end: 3,
      autoClose: false,
    });
    expect(f.create.mock.results.at(0)?.value).toBe(f.stream);
    expect(f.capability.createReadStream.mock.calls.at(0)?.at(0)).toBe(
      f.create.mock.calls.at(0)?.at(1),
    );
    expect(f.chunks).toHaveLength(1);
    expect(f.chunks.at(0)).toBe(f.body);
    expect(f.setHeader.mock.calls).toEqual([
      ['content-type', 'video/mp4'],
      ['accept-ranges', 'bytes'],
      ['cache-control', 'private, no-store, no-transform'],
      ['etag', ETAG],
      ['last-modified', f.media.readyAt.toUTCString()],
      ['x-content-type-options', 'nosniff'],
      ['content-disposition', 'attachment; filename="incident-clip.mp4"'],
      ['content-length', '4'],
    ]);
    expect(f.status).toHaveBeenCalledWith(200);
    expect(f.events.at(0)).toBe('open');
    expect(f.events.indexOf('create')).toBeGreaterThan(
      f.events.indexOf('header:content-length'),
    );
    expect(f.events.at(-1)).toBe('close');
    expect(f.close).toHaveBeenCalledWith(f.handle);
    expect(f.capability.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ifRange: undefined, status: 206, start: 1, end: 2 },
    { ifRange: ETAG, status: 206, start: 1, end: 2 },
    { ifRange: '"other"', status: 200, start: 0, end: 3 },
  ])('preserves range and If-Range options: $ifRange', async (selection) => {
    const headers: Record<string, string> = { range: 'bytes=1-2' };
    if (selection.ifRange !== undefined)
      headers['if-range'] = selection.ifRange;
    const f = setup(headers);
    await f.controller.getDownload(f.request, 'alert-1', f.response);
    expect(f.status).toHaveBeenCalledWith(selection.status);
    expect(f.create).toHaveBeenCalledWith(f.handle, {
      start: selection.start,
      end: selection.end,
      autoClose: false,
    });
    expect(f.setHeader).toHaveBeenCalledWith(
      'content-length',
      String(selection.end - selection.start + 1),
    );
    if (selection.status === 206)
      expect(f.setHeader).toHaveBeenCalledWith('content-range', 'bytes 1-2/4');
    else
      expect(
        f.setHeader.mock.calls.some(([name]) => name === 'content-range'),
      ).toBe(false);
    expect(f.capability.close).toHaveBeenCalledTimes(1);
  });

  it.each([ETAG, `W/${ETAG}`, '*', `"unrelated", ${ETAG}`])(
    '304 precedes invalid range selection after opening and setting headers: %s',
    async (etag) => {
      const f = setup({ 'if-none-match': etag, range: 'invalid' });
      await f.controller.getDownload(f.request, 'alert-1', f.response);
      expect(f.status.mock.calls).toEqual([[304]]);
      expect(f.events.at(0)).toBe('open');
      expect(f.events.indexOf('status:304')).toBeGreaterThan(
        f.events.indexOf('header:content-disposition'),
      );
      expect(
        f.setHeader.mock.calls.some(
          ([name]) => name === 'content-length' || name === 'content-range',
        ),
      ).toBe(false);
      expect(f.end).toHaveBeenCalledTimes(1);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.capability.close).toHaveBeenCalledTimes(1);
    },
  );

  it('does not return 304 for a nonmatching conditional request', async () => {
    const f = setup({ 'if-none-match': '"other"' });
    await f.controller.getDownload(f.request, 'alert-1', f.response);
    expect(f.status.mock.calls).toEqual([[200]]);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    { range: undefined, etag: undefined, status: 200 },
    { range: 'bytes=1-2', etag: undefined, status: 206 },
    { range: 'bytes=9-', etag: undefined, status: 416 },
    { range: 'invalid', etag: ETAG, status: 304 },
  ])('HEAD closes without a stream for status $status', async (selection) => {
    const headers: Record<string, string> = {};
    if (selection.range !== undefined) headers.range = selection.range;
    if (selection.etag !== undefined) headers['if-none-match'] = selection.etag;
    const f = setup(headers);
    await f.controller.headDownload(f.request, 'alert-1', f.response);
    expect(f.status.mock.calls).toEqual([[selection.status]]);
    expect(f.end).toHaveBeenCalledTimes(1);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.capability.close).toHaveBeenCalledTimes(1);
  });

  it('GET returns 416 and closes without streaming an unsatisfiable range', async () => {
    const f = setup({ range: 'bytes=9-' });
    await f.controller.getDownload(f.request, 'alert-1', f.response);
    expect(f.status).toHaveBeenCalledWith(416);
    expect(f.setHeader).toHaveBeenCalledWith('content-range', 'bytes */4');
    expect(f.setHeader).toHaveBeenCalledWith('content-length', '0');
    expect(f.end).toHaveBeenCalledTimes(1);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.capability.close).toHaveBeenCalledTimes(1);
  });

  it('rejects absent scope before opening', async () => {
    const f = setup();
    delete f.request.effectiveFacilityId;
    await expect(
      f.controller.getDownload(f.request, 'alert-1', f.response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.setHeader).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it('propagates permission/open failure even when If-None-Match matches', async () => {
    const f = setup({ 'if-none-match': ETAG });
    const failure = new Error('permission denied');
    f.open.mockRejectedValue(failure);
    await expect(
      f.controller.getDownload(f.request, 'alert-1', f.response),
    ).rejects.toBe(failure);
    expect(f.setHeader).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it('waits for open completion before headers and 304', async () => {
    const f = setup({ 'if-none-match': ETAG });
    let complete: (media: typeof f.media) => void = () => {
      throw new Error('Missing resolver');
    };
    f.open.mockReturnValue(
      new Promise<typeof f.media>((resolve) => {
        complete = resolve;
      }),
    );
    const action = f.controller.getDownload(f.request, 'alert-1', f.response);
    expect(f.setHeader).not.toHaveBeenCalled();
    expect(f.status).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    complete(f.media);
    await action;
    expect(f.status).toHaveBeenCalledWith(304);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { stage: 'header', sent: false },
    { stage: 'header', sent: true },
    { stage: 'create', sent: false },
    { stage: 'create', sent: true },
    { stage: 'pipeline', sent: false },
    { stage: 'pipeline', sent: true },
  ])(
    'suppresses only pipeline errors after headersSent: $stage/$sent',
    async ({ stage, sent }) => {
      const f = setup();
      Object.defineProperty(f.response, 'headersSent', { value: sent });
      const failure = new Error(`${stage} failed`);
      if (stage === 'header')
        f.setHeader.mockImplementation(() => {
          throw failure;
        });
      if (stage === 'create')
        f.capability.createReadStream.mockImplementation(() => {
          throw failure;
        });
      if (stage === 'pipeline')
        f.capability.createReadStream.mockImplementation(
          () =>
            new Readable({
              read() {
                this.destroy(failure);
              },
            }),
        );
      const action = f.controller.getDownload(f.request, 'alert-1', f.response);
      if (stage === 'pipeline' && sent)
        await expect(action).resolves.toBeUndefined();
      else await expect(action).rejects.toBe(failure);
      expect(f.capability.close).toHaveBeenCalledTimes(1);
      expect(f.events.at(-1)).toBe('close');
      if (stage === 'header') expect(f.create).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'header', 'pipeline-before', 'pipeline-after', '304'])(
    'close failure takes precedence on %s',
    async (stage) => {
      const f = setup(stage === '304' ? { 'if-none-match': ETAG } : {});
      const closeFailure = new Error('close failed');
      f.capability.close.mockImplementation(() => Promise.reject(closeFailure));
      if (stage === 'header')
        f.setHeader.mockImplementation(() => {
          throw new Error('header failed');
        });
      if (stage.startsWith('pipeline')) {
        Object.defineProperty(f.response, 'headersSent', {
          value: stage === 'pipeline-after',
        });
        f.capability.createReadStream.mockImplementation(
          () =>
            new Readable({
              read() {
                this.destroy(new Error('pipeline failed'));
              },
            }),
        );
      }
      await expect(
        f.controller.getDownload(f.request, 'alert-1', f.response),
      ).rejects.toBe(closeFailure);
      expect(f.capability.close).toHaveBeenCalledTimes(1);
    },
  );
});
