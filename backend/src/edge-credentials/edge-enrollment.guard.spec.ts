import type { ExecutionContext } from '@nestjs/common';
import type { EdgeCredentialAuthenticator } from './edge-credential-authenticator.js';
import { EdgeEnrollmentGuard } from './edge-enrollment.guard.js';
import type { EnrollmentRateLimiter } from './enrollment-rate-limiter.js';

function context(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('EdgeEnrollmentGuard', () => {
  const authenticated = {
    binding: { facilityCode: 'facility-code' },
    principal: {
      tokenId: 'token-id',
      facilityId: 'facility-id',
      edgeInstallationId: 'installation-id',
      enrollmentGeneration: 1,
    },
  } as const;

  it('rate limits, authenticates pending enrollment credentials, and binds the result', async () => {
    const limiter = { consume: jest.fn().mockReturnValue(true) };
    const authenticator = {
      authenticateForEnrollment: jest.fn().mockResolvedValue(authenticated),
    };
    const request = {
      headers: {
        authorization: 'Bearer eft_v1.token.secret',
        'x-forwarded-for': '203.0.113.10, 10.0.0.2',
      },
      body: { facilityCode: 'facility-code' },
      ip: '10.0.0.2',
      socket: {},
    };
    const guard = new EdgeEnrollmentGuard(
      limiter as unknown as EnrollmentRateLimiter,
      authenticator as unknown as EdgeCredentialAuthenticator,
    );

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(limiter.consume).toHaveBeenCalledWith(
      '203.0.113.10',
      'facility-code',
    );
    expect(authenticator.authenticateForEnrollment).toHaveBeenCalledWith(
      'eft_v1.token.secret',
    );
    expect(request).toHaveProperty('edgeEnrollment', authenticated);
  });

  it('rejects at the existing limiter before credential authentication', async () => {
    const limiter = { consume: jest.fn().mockReturnValue(false) };
    const authenticator = { authenticateForEnrollment: jest.fn() };
    const guard = new EdgeEnrollmentGuard(
      limiter as unknown as EnrollmentRateLimiter,
      authenticator as unknown as EdgeCredentialAuthenticator,
    );

    await expect(
      guard.canActivate(
        context({
          headers: { authorization: 'Bearer invalid' },
          body: { facilityCode: 'facility-code' },
          ip: '127.0.0.1',
          socket: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(authenticator.authenticateForEnrollment).not.toHaveBeenCalled();
  });
});
