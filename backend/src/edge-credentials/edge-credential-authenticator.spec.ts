import { ConfigService } from '@nestjs/config';
import { EdgeCredentialAuthenticatorService } from './services/edge-credential-authenticator.service.js';

const principal = {
  tokenId: '7H2K9M4QXP3R',
  facilityId: 'facility-1',
  edgeInstallationId: 'c72bd9a7-3e04-47ba-a8cd-a56e54f98152',
  enrollmentGeneration: 1,
};

describe('EdgeCredentialAuthenticatorService request binding', () => {
  it.each(['validationRunId', 'validation_run_id'])(
    'does not parse or resolve retired auth field %s',
    async (field) => {
      const activeValidationGrant = jest.fn().mockResolvedValue({ id: 'old' });
      const repository = {
        requestResourcesBelongTo: jest.fn().mockResolvedValue(true),
        activeValidationGrant,
      };
      const authenticator = new EdgeCredentialAuthenticatorService(
        new ConfigService(),
        repository as never,
        { now: () => new Date('2026-08-13T00:00:00.000Z') },
      );

      await expect(
        authenticator.bindRequest(
          {
            headers: {},
            body: {
              [field]: '0197f671-3a31-7a6c-a6e4-83ed412de80f',
            },
          },
          principal,
        ),
      ).resolves.toEqual(principal);
      expect(activeValidationGrant).not.toHaveBeenCalled();
    },
  );
});
