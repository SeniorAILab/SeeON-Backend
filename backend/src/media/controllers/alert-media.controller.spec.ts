import { UnauthorizedException } from '@nestjs/common';
import type { FileHandle } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import type { Response } from 'express';
import type { RequestWithAuth } from '../../auth/guards/jwt-auth.guard.js';
import { AlertMediaService } from '../services/alert-media.service.js';
import type { AlertMediaRepository } from '../repositories/alert-media.repository.js';
import { AlertMediaController } from './alert-media.controller.js';

function setup(headers: Record<string, string> = {}) {
  const events: string[] = [];
  const body = Buffer.from([0, 255, 13, 10]);
  const chunks: Buffer[] = [];
  const stream = Readable.from([body]);
  const nativeClosePromise = Promise.resolve();
  const capability = {
    createReadStream: jest.fn<
      Readable,
      [Parameters<FileHandle['createReadStream']>[0]]
    >(() => stream),
    close: jest.fn(() => nativeClosePromise),
  };
  // Only these two native capability methods are exercised; no file is opened.
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
  capability.createReadStream.mockImplementation(() => {
    events.push('create');
    return stream;
  });
  capability.close.mockImplementation(() => {
    events.push('close');
    return nativeClosePromise;
  });
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
  const status = jest.fn((code: number) => {
    events.push(`status:${code}`);
  });
  const response = Object.assign(writable, { setHeader, status });
  const end = jest.spyOn(response, 'end');
  const request = {
    effectiveFacilityId: 'facility-1',
    headers,
  } as unknown as RequestWithAuth;
  return {
    controller: new AlertMediaController(service),
    service,
    request,
    response: response as unknown as Response,
    events,
    body,
    chunks,
    stream,
    handle,
    capability,
    nativeClosePromise,
    media,
    open,
    create,
    close,
    setHeader,
    status,
    end,
  };
}

describe('AlertMediaController inline content capability lifecycle', () => {
  it('opens before headers, preserves the stream and buffer, and closes after GET piping', async () => {
    const f = setup();
    await expect(
      f.controller.getContent(f.request, 'alert-1', f.response),
    ).resolves.toBeUndefined();
    expect(f.open).toHaveBeenCalledWith('facility-1', 'alert-1');
    expect(f.create).toHaveBeenCalledWith(f.handle, {
      start: 0,
      end: 3,
      autoClose: false,
    });
    expect(f.capability.createReadStream).toHaveBeenCalledWith({
      start: 0,
      end: 3,
      autoClose: false,
    });
    expect(f.create.mock.results.at(0)?.value).toBe(f.stream);
    expect(f.chunks).toHaveLength(1);
    expect(f.chunks.at(0)).toBe(f.body);
    expect(f.setHeader.mock.calls).toEqual([
      ['content-type', 'video/mp4'],
      ['accept-ranges', 'bytes'],
      ['cache-control', 'private, no-store, no-transform'],
      ['etag', `"sha256-${f.media.sha256}"`],
      ['last-modified', f.media.readyAt.toUTCString()],
      ['x-content-type-options', 'nosniff'],
      ['content-disposition', 'inline'],
      ['content-length', '4'],
    ]);
    expect(f.status).toHaveBeenCalledWith(200);
    expect(f.events.at(0)).toBe('open');
    expect(f.events.indexOf('create')).toBeGreaterThan(
      f.events.indexOf('header:content-length'),
    );
    expect(f.events.at(-1)).toBe('close');
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledWith(f.handle);
    expect(f.capability.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { range: 'bytes=1-2', ifRange: undefined, status: 206, start: 1, end: 2 },
    {
      range: 'bytes=1-2',
      ifRange: `"sha256-${'a'.repeat(64)}"`,
      status: 206,
      start: 1,
      end: 2,
    },
    { range: 'bytes=1-2', ifRange: '"other"', status: 200, start: 0, end: 3 },
  ])('preserves range and If-Range selection: $ifRange', async (selection) => {
    const headers: Record<string, string> = { range: selection.range };
    if (selection.ifRange !== undefined)
      headers['if-range'] = selection.ifRange;
    const f = setup(headers);
    await f.controller.getContent(f.request, 'alert-1', f.response);
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
    if (selection.status === 206) {
      expect(f.setHeader).toHaveBeenCalledWith('content-range', 'bytes 1-2/4');
    } else {
      expect(
        f.setHeader.mock.calls.some(([name]) => name === 'content-range'),
      ).toBe(false);
    }
    expect(f.capability.close).toHaveBeenCalledTimes(1);
  });

  it.each(['get', 'head'])(
    'ends unsatisfiable %s with 416 and closes without a stream',
    async (method) => {
      const f = setup({ range: 'bytes=9-' });
      if (method === 'head')
        await f.controller.headContent(f.request, 'alert-1', f.response);
      else await f.controller.getContent(f.request, 'alert-1', f.response);
      expect(f.status).toHaveBeenCalledWith(416);
      expect(f.setHeader).toHaveBeenCalledWith('content-range', 'bytes */4');
      expect(f.setHeader).toHaveBeenCalledWith('content-length', '0');
      expect(f.end).toHaveBeenCalledTimes(1);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.capability.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, 'bytes=1-2'])(
    'HEAD selects headers but never creates a stream: %p',
    async (range) => {
      const headers: Record<string, string> = {};
      if (range !== undefined) headers.range = range;
      const f = setup(headers);
      await f.controller.headContent(f.request, 'alert-1', f.response);
      expect(f.status).toHaveBeenCalledWith(range !== undefined ? 206 : 200);
      expect(f.end).toHaveBeenCalledTimes(1);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.capability.close).toHaveBeenCalledTimes(1);
    },
  );

  it('does not synthesize 304 for a matching If-None-Match', async () => {
    const f = setup({ 'if-none-match': `"sha256-${'a'.repeat(64)}"` });
    await f.controller.getContent(f.request, 'alert-1', f.response);
    expect(f.status).toHaveBeenCalledWith(200);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('rejects absent facility scope before opening or closing', async () => {
    const f = setup();
    delete f.request.effectiveFacilityId;
    await expect(
      f.controller.getContent(f.request, 'alert-1', f.response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.setHeader).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it('leaves failed open outside the close scope', async () => {
    const f = setup();
    const failure = new Error('authorization or open failed');
    f.open.mockRejectedValue(failure);
    await expect(
      f.controller.getContent(f.request, 'alert-1', f.response),
    ).rejects.toBe(failure);
    expect(f.setHeader).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it('waits for open completion before headers or cleanup', async () => {
    const f = setup();
    let complete: (media: typeof f.media) => void = () => {
      throw new Error('Pending open was not initialized');
    };
    const pending = new Promise<typeof f.media>((resolve) => {
      complete = resolve;
    });
    f.open.mockReturnValue(pending);
    const action = f.controller.headContent(f.request, 'alert-1', f.response);
    expect(f.setHeader).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    complete(f.media);
    await action;
    expect(f.setHeader).toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it.each(['header', 'create', 'pipeline'])(
    'closes once and preserves %s failure identity',
    async (stage) => {
      const f = setup();
      const failure = new Error(`${stage} failed`);
      if (stage === 'header')
        f.setHeader.mockImplementation(() => {
          throw failure;
        });
      if (stage === 'create')
        f.capability.createReadStream.mockImplementation(() => {
          throw failure;
        });
      if (stage === 'pipeline') {
        f.capability.createReadStream.mockImplementation(
          () =>
            new Readable({
              read() {
                this.destroy(failure);
              },
            }),
        );
      }
      await expect(
        f.controller.getContent(f.request, 'alert-1', f.response),
      ).rejects.toBe(failure);
      expect(f.capability.close).toHaveBeenCalledTimes(1);
      if (stage === 'header') expect(f.create).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'preserves final close failure precedence, earlier failure=%s',
    async (failEarlier) => {
      const f = setup();
      const closeFailure = new Error('close failed');
      f.capability.close.mockImplementation(() => Promise.reject(closeFailure));
      if (failEarlier)
        f.setHeader.mockImplementation(() => {
          throw new Error('header failed');
        });
      await expect(
        f.controller.getContent(f.request, 'alert-1', f.response),
      ).rejects.toBe(closeFailure);
      expect(f.capability.close).toHaveBeenCalledTimes(1);
    },
  );

  it('service delegates the original options and returns native stream/promise identities directly', () => {
    const f = setup();
    const options = { start: 1, end: 2, autoClose: false };
    expect(f.service.createContentReadStream(f.handle, options)).toBe(f.stream);
    expect(f.capability.createReadStream.mock.calls).toHaveLength(1);
    expect(f.capability.createReadStream.mock.calls.at(0)?.at(0)).toBe(options);
    expect(f.service.closeContent(f.handle)).toBe(f.nativeClosePromise);
    expect(f.capability.close).toHaveBeenCalledTimes(1);
  });
});
