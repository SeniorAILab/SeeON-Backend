import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { MediaDownloadAuditConsistencyError } from '../errors/media-download-audit-consistency.error.js';
import { MediaDownloadAuditRepository } from './media-download-audit.repository.js';

function setup(auditCount = 1, outboxCount = 1) {
  const audit = jest
    .fn<Promise<{ count: number }>, [Prisma.MediaDownloadAuditUpdateManyArgs]>()
    .mockResolvedValue({ count: auditCount });
  const outbox = jest
    .fn<
      Promise<{ count: number }>,
      [Prisma.MediaDownloadOutboxJobUpdateManyArgs]
    >()
    .mockResolvedValue({ count: outboxCount });
  const tx = {
    mediaDownloadAudit: { updateMany: audit },
    mediaDownloadOutboxJob: { updateMany: outbox },
  };
  const withFacilityContext = jest.fn(
    (
      _facilityId: string,
      action: (transaction: typeof tx) => Promise<unknown>,
    ) => action(tx),
  );
  // Only the callback/delegates used by completeDownload are supplied. No DB
  // connection or transaction rollback behavior is represented by this fixture.
  const prisma = { withFacilityContext } as unknown as PrismaService;
  const input = {
    id: 'audit-1',
    facilityId: 'facility-1',
    processId: 'process-1',
    leaseVersion: 7,
    bytesActual: 3,
    now: new Date('2026-07-06T00:00:00.000Z'),
  };
  return {
    repository: new MediaDownloadAuditRepository(prisma),
    audit,
    outbox,
    withFacilityContext,
    input,
  };
}

describe('MediaDownloadAuditRepository completion protocol', () => {
  it('does not mutate the outbox when the audit lease no longer matches', async () => {
    const f = setup(0);
    await expect(f.repository.completeDownload(f.input)).resolves.toBe(false);
    expect(f.outbox).not.toHaveBeenCalled();
  });

  it.each([0, 2])(
    'rejects an outbox update count of %s with the domain error',
    async (count) => {
      const f = setup(1, count);
      const action = f.repository.completeDownload(f.input);
      await expect(action).rejects.toBeInstanceOf(
        MediaDownloadAuditConsistencyError,
      );
      await expect(action).rejects.toMatchObject({
        name: 'MediaDownloadAuditConsistencyError',
        message: 'download audit and recovery job lease versions diverged',
      });
    },
  );

  it('retains the facility, process and version fences and updates the outbox after the audit', async () => {
    const f = setup();
    await expect(f.repository.completeDownload(f.input)).resolves.toBe(true);
    expect(f.withFacilityContext).toHaveBeenCalledWith(
      f.input.facilityId,
      expect.any(Function),
    );
    expect(f.audit).toHaveBeenCalledWith({
      where: {
        id: f.input.id,
        facilityId: f.input.facilityId,
        processId: f.input.processId,
        state: 'STARTED',
        leaseVersion: f.input.leaseVersion,
      },
      data: {
        state: 'COMPLETED',
        leaseVersion: { increment: 1 },
        bytesActual: 3n,
        completedAt: f.input.now,
      },
    });
    expect(f.outbox).toHaveBeenCalledWith({
      where: {
        auditId: f.input.id,
        facilityId: f.input.facilityId,
        state: 'PENDING',
        leaseVersion: f.input.leaseVersion,
      },
      data: {
        state: 'COMPLETED',
        leaseVersion: { increment: 1 },
        completedAt: f.input.now,
      },
    });
    const auditOrder = f.audit.mock.invocationCallOrder.at(0);
    const outboxOrder = f.outbox.mock.invocationCallOrder.at(0);
    if (auditOrder === undefined || outboxOrder === undefined) {
      throw new Error('Expected both audit and outbox updates');
    }
    expect(auditOrder).toBeLessThan(outboxOrder);
    expect(f.outbox.mock.calls.at(0)?.[0].data.completedAt).toBe(f.input.now);
  });

  it('propagates the original outbox failure without translating it', async () => {
    const f = setup();
    const failure = new Error('outbox update failed');
    f.outbox.mockRejectedValueOnce(failure);
    await expect(f.repository.completeDownload(f.input)).rejects.toBe(failure);
  });
});
