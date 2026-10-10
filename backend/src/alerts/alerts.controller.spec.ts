import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PassThrough, Readable } from 'node:stream';
import { response } from 'express';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  JwtAuthGuard,
  RequireFacilityGuard,
} from '../auth/guards/jwt-auth.guard';
import { readArray } from '../../test/helpers/json-response';
import type { RequestWithAuth } from '../auth/guards/jwt-auth.guard';
import type { AlertsService } from './services/alerts.service';
import { AlertsController } from './controllers/alerts.controller';
import { MAX_SNAPSHOT_BYTES } from '../common/snapshot-storage.js';

function setup() {
  const resolve = jest.fn().mockResolvedValue({ id: 'a1', status: 'RESOLVED' });
  const ack = jest.fn().mockResolvedValue({ id: 'a1', status: 'ACKED' });
  const addNote = jest.fn().mockResolvedValue({ id: 'n1', note: 'checked' });
  const getOne = jest.fn().mockResolvedValue({ id: 'resolved-alert' });
  const saveSnapshot = jest
    .fn()
    .mockResolvedValue({ snapshotKey: 'saved-key' });
  const getSnapshotPath = jest.fn().mockResolvedValue('/snapshots/saved-file');
  const stream = new PassThrough();
  const openSnapshot = jest.fn(() => stream);
  const service = {
    resolve,
    ack,
    addNote,
    getOne,
    saveSnapshot,
    getSnapshotPath,
    openSnapshot,
  } as unknown as AlertsService;
  return {
    controller: new AlertsController(service),
    resolve,
    ack,
    addNote,
    getOne,
    saveSnapshot,
    getSnapshotPath,
    openSnapshot,
    stream,
  };
}

function req(user: Record<string, unknown> | undefined): RequestWithAuth {
  return { user } as unknown as RequestWithAuth;
}

describe('AlertsController lifecycle routes', () => {
  it('resolve passes the session facility + actor id', async () => {
    const { controller, resolve } = setup();
    const result = await controller.resolve(
      req({ id: 'user-2', facilityId: 'facility-1' }),
      'a1',
    );
    expect(resolve).toHaveBeenCalledWith('facility-1', 'a1', 'user-2');
    expect(result).toMatchObject({ status: 'RESOLVED' });
  });

  it('addNote passes facility, actor id, and role snapshot', async () => {
    const { controller, addNote } = setup();
    const result = await controller.addNote(
      req({ id: 'user-2', facilityId: 'facility-1', role: 'STAFF' }),
      'a1',
      { note: 'checked' },
    );
    expect(addNote).toHaveBeenCalledWith({
      facilityId: 'facility-1',
      alertId: 'a1',
      note: 'checked',
      actorUserId: 'user-2',
      actorRole: 'STAFF',
    });
    expect(result).toMatchObject({ note: 'checked' });
  });

  it('rejects when the session has no facility context', () => {
    const { controller } = setup();
    expect(() => controller.resolve(req({ id: 'user-1' }), 'a1')).toThrow(
      ForbiddenException,
    );
  });

  it('rejects when the session has no user id', () => {
    const { controller } = setup();
    expect(() =>
      controller.resolve(req({ facilityId: 'facility-1' }), 'a1'),
    ).toThrow(ForbiddenException);
  });
});

describe('AlertsController ack route protection', () => {
  it('컨트롤러 전체가 JWT + 시설 가드 뒤에 있다', () => {
    // ack는 메서드 레벨 가드가 없다. 클래스 레벨 보호가 사라지면 새 라우트가
    // 무방비로 노출되므로 여기서 고정한다.
    const guards = readArray(
      Reflect.getMetadata(GUARDS_METADATA, AlertsController),
      'AlertsController guards',
    );
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(RequireFacilityGuard);
  });

  it('ack는 세션 시설로 스코프된다', async () => {
    const { controller, ack } = setup();

    await controller.ack(
      { effectiveFacilityId: 'facility-1', user: { id: 'user-1' } } as never,
      'alert-1',
    );

    expect(ack).toHaveBeenCalledWith('facility-1', 'alert-1', 'user-1');
  });

  it('시설 컨텍스트가 없으면 ack가 거부된다', () => {
    const { controller, ack } = setup();

    expect(() =>
      controller.ack({ user: { id: 'user-1' } } as never, 'alert-1'),
    ).toThrow(ForbiddenException);
    expect(ack).not.toHaveBeenCalled();
  });
});

describe('AlertsController snapshot transport', () => {
  afterEach(() => jest.restoreAllMocks());

  function uploadRequest(
    contentType: string,
    chunks: Buffer[],
    consumed: () => void,
  ) {
    return Object.assign(req({ facilityId: 'facility-1' }), {
      headers: { 'content-type': contentType },
      async *[Symbol.asyncIterator]() {
        consumed();
        yield* Readable.from(chunks);
      },
    });
  }

  it('authorizes before MIME/body handling and saves the resolved alert ID without dropping bytes', async () => {
    const { controller, getOne, saveSnapshot } = setup();
    const events: string[] = [];
    getOne.mockImplementation(() => {
      events.push('authorize');
      return Promise.resolve({ id: 'resolved-alert' });
    });
    const bytes = Buffer.from([0, 255, 13, 10, 42]);
    const result = await controller.uploadSnapshot(
      uploadRequest(
        ' IMAGE/PNG ; charset=binary',
        [bytes.subarray(0, 2), bytes.subarray(2)],
        () => events.push('body'),
      ),
      'requested-alert',
    );
    expect(events).toEqual(['authorize', 'body']);
    expect(getOne).toHaveBeenCalledWith('facility-1', 'requested-alert');
    expect(saveSnapshot).toHaveBeenCalledWith(
      'facility-1',
      'resolved-alert',
      'png',
      bytes,
    );
    expect(result).toEqual({ snapshotKey: 'saved-key' });
  });

  it('propagates authorization failure before invalid MIME or request iteration', async () => {
    const { controller, getOne, saveSnapshot } = setup();
    const failure = new Error('scope denied');
    getOne.mockRejectedValue(failure);
    const consumed = jest.fn();
    await expect(
      controller.uploadSnapshot(
        uploadRequest('invalid', [Buffer.from('payload')], consumed),
        'a1',
      ),
    ).rejects.toBe(failure);
    expect(consumed).not.toHaveBeenCalled();
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it('rejects unsupported MIME after authorization but before reading the body', async () => {
    const { controller, getOne, saveSnapshot } = setup();
    const consumed = jest.fn();
    await expect(
      controller.uploadSnapshot(
        uploadRequest('text/plain', [Buffer.from('payload')], consumed),
        'a1',
      ),
    ).rejects.toThrow('Unsupported snapshot content type');
    expect(getOne).toHaveBeenCalledTimes(1);
    expect(consumed).not.toHaveBeenCalled();
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it.each([Buffer.alloc(0), Buffer.alloc(MAX_SNAPSHOT_BYTES + 1)])(
    'rejects empty or oversized bodies before persistence',
    async (body) => {
      const { controller, saveSnapshot } = setup();
      await expect(
        controller.uploadSnapshot(
          uploadRequest('image/jpeg', [body], () => undefined),
          'a1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(saveSnapshot).not.toHaveBeenCalled();
    },
  );

  it('preserves request stream errors without starting persistence', async () => {
    const { controller, saveSnapshot } = setup();
    const failure = new Error('request stream failed');
    const request = uploadRequest('image/jpeg', [], () => {
      throw failure;
    });
    await expect(controller.uploadSnapshot(request, 'a1')).rejects.toBe(
      failure,
    );
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it('sets both headers before opening and piping the identical stream, returning void', async () => {
    const { controller, getSnapshotPath, openSnapshot, stream } = setup();
    const events: string[] = [];
    const setHeader = jest
      .spyOn(response, 'setHeader')
      .mockImplementation(() => {
        events.push('header');
        return response;
      });
    openSnapshot.mockImplementation(() => {
      events.push('open');
      return stream;
    });
    const pipe = jest
      .spyOn(stream, 'pipe')
      .mockImplementation((destination) => {
        events.push('pipe');
        return destination;
      });
    const result = await controller.snapshot(
      req({ facilityId: 'facility-1' }),
      'a1',
      response,
    );
    expect(getSnapshotPath).toHaveBeenCalledWith('facility-1', 'a1');
    expect(setHeader.mock.calls).toEqual([
      ['content-type', 'image/jpeg'],
      ['cache-control', 'private, max-age=300'],
    ]);
    expect(events).toEqual(['header', 'header', 'open', 'pipe']);
    expect(openSnapshot).toHaveBeenCalledWith('/snapshots/saved-file');
    expect(pipe).toHaveBeenCalledWith(response);
    expect(result).toBeUndefined();
  });

  it('does not set headers or open a file when lookup rejects', async () => {
    const { controller, getSnapshotPath, openSnapshot } = setup();
    const failure = new Error('snapshot missing');
    getSnapshotPath.mockRejectedValue(failure);
    const setHeader = jest.spyOn(response, 'setHeader');
    await expect(
      controller.snapshot(req({ facilityId: 'facility-1' }), 'a1', response),
    ).rejects.toBe(failure);
    expect(setHeader).not.toHaveBeenCalled();
    expect(openSnapshot).not.toHaveBeenCalled();
  });
});
