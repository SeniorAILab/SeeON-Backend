import { ConfigService } from '@nestjs/config';
import { EdgeAdminService } from './edge-admin.service';
import { EdgeCredentialAuthenticator } from './edge-credential-authenticator';

const VALIDATION_RUN_ID = '0197f671-3a31-7a6c-a6e4-83ed412de80f';
const INSTALLATION_ID = 'c72bd9a7-3e04-47ba-a8cd-a56e54f98152';
const NOW = new Date('2026-08-12T12:00:00.000Z');

describe('SYSTEM_TEST validation capability', () => {
  it('binds capability only from the active server-side grant', async () => {
    const repository = {
      requestResourcesBelongTo: jest.fn().mockResolvedValue(true),
      activeValidationGrant: jest.fn().mockResolvedValue({
        id: VALIDATION_RUN_ID,
        capability: 'SYSTEM_TEST',
      }),
    };
    const authenticator = new EdgeCredentialAuthenticator(
      new ConfigService({}),
      repository as never,
      { now: () => NOW },
    );
    const principal = {
      tokenId: '7H2K9M4QXP3R',
      facilityId: 'facility-1',
      edgeInstallationId: INSTALLATION_ID,
      enrollmentGeneration: 1,
    };

    await expect(
      authenticator.bindRequest(
        {
          headers: {},
          body: { validation_run_id: VALIDATION_RUN_ID },
        },
        principal,
      ),
    ).resolves.toEqual({
      ...principal,
      validationRunId: VALIDATION_RUN_ID,
      validationCapability: 'SYSTEM_TEST',
    });
  });

  it('creates ordinary grants without capability and SYSTEM_TEST grants only when explicit', async () => {
    const createValidationGrant = jest.fn().mockResolvedValue({ ok: true });
    const service = new EdgeAdminService(
      { createValidationGrant } as never,
      { findOperation: jest.fn().mockResolvedValue(null) } as never,
      { now: () => NOW },
    );
    const context = {
      idempotencyKey: 'system-test-grant-1',
      actorUserId: 'super-admin-1',
      requestId: 'request-1',
    };

    await service.createValidationRun(
      INSTALLATION_ID,
      {
        schemaVersion: 1,
        expectedEnrollmentGeneration: 1,
        durationSeconds: 600,
        capability: 'SYSTEM_TEST',
      },
      context,
    );

    expect(createValidationGrant).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'SYSTEM_TEST' }),
    );
  });
});
