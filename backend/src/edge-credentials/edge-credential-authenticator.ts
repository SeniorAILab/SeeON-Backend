import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EdgeCredentialLifecycle, EdgeInstallationState } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { EDGE_CLOCK, type EdgeClock } from './edge-clock.js';
import { tokenDigest } from './edge-credential-crypto.js';
import { EdgeCredentialQueryRepository } from './edge-credential-query.repository.js';
import {
  EDGE_TOKEN_PATTERN,
  type CredentialBinding,
  type EdgeAuthenticatedRequest,
  type EdgePrincipal,
} from './edge-credential.types.js';
import { EDGE_ERROR_CODES, edgeHttpError } from './edge-errors.js';

export type AuthenticatedEnrollment = {
  readonly binding: CredentialBinding;
  readonly principal: EdgePrincipal;
};

@Injectable()
export class EdgeCredentialAuthenticator {
  constructor(
    private readonly config: ConfigService,
    private readonly repository: EdgeCredentialQueryRepository,
    @Inject(EDGE_CLOCK) private readonly clock: EdgeClock,
  ) {}

  async authenticate(fullToken: string): Promise<EdgePrincipal> {
    const authenticated = await this.authenticateForEnrollment(fullToken);
    if (
      authenticated.binding.generationState !== EdgeInstallationState.CLAIMED
    ) {
      throw edgeHttpError(403, EDGE_ERROR_CODES.INACTIVE);
    }
    return authenticated.principal;
  }

  async authenticateForEnrollment(
    fullToken: string,
  ): Promise<AuthenticatedEnrollment> {
    const pepper = this.config.get<string>('EDGE_TOKEN_PEPPER')?.trim();
    if (!pepper) {
      throw edgeHttpError(503, EDGE_ERROR_CODES.NOT_CONFIGURED, true);
    }
    const match = EDGE_TOKEN_PATTERN.exec(fullToken);
    const binding =
      match === null ? null : await this.repository.findCredential(match[1]);
    const actual = tokenDigest(pepper, fullToken);
    const expected = Buffer.from(binding?.tokenDigest ?? '0'.repeat(64), 'hex');
    if (!timingSafeEqual(actual, expected) || binding === null) {
      throw edgeHttpError(401, EDGE_ERROR_CODES.INVALID);
    }
    await this.assertLifecycle(binding, this.clock.now());
    return {
      binding,
      principal: {
        tokenId: binding.tokenId,
        facilityId: binding.facilityId,
        edgeInstallationId: binding.edgeInstallationId,
        enrollmentGeneration: binding.enrollmentGeneration,
      },
    };
  }

  async bindRequest(
    request: EdgeAuthenticatedRequest,
    principal: EdgePrincipal,
  ): Promise<EdgePrincipal> {
    const body = record(request.body);
    const facilityClaims = [
      header(request.headers['x-facility-id']),
      request.params?.facilityId ?? null,
      string(body?.facilityId),
      string(body?.facility_id),
    ].filter((value): value is string => value !== null);
    if (facilityClaims.some((value) => value !== principal.facilityId)) {
      throw edgeHttpError(403, EDGE_ERROR_CODES.MISMATCH);
    }
    const installationId = string(body?.edgeInstallationId);
    if (
      installationId !== null &&
      installationId !== principal.edgeInstallationId
    ) {
      throw edgeHttpError(403, EDGE_ERROR_CODES.MISMATCH);
    }
    const generation = integer(body?.enrollmentGeneration);
    if (generation !== null && generation !== principal.enrollmentGeneration) {
      throw edgeHttpError(409, EDGE_ERROR_CODES.STALE_GENERATION);
    }
    if (!(await this.repository.requestResourcesBelongTo(request, principal))) {
      throw edgeHttpError(403, EDGE_ERROR_CODES.MISMATCH);
    }
    const validationRunId =
      string(body?.validationRunId) ?? string(body?.validation_run_id);
    if (validationRunId === null) return principal;
    const grant = await this.repository.activeValidationGrant(
      principal,
      validationRunId,
      this.clock.now(),
    );
    if (grant === null) throw edgeHttpError(403, EDGE_ERROR_CODES.MISMATCH);
    return { ...principal, validationRunId };
  }

  private async assertLifecycle(
    binding: CredentialBinding,
    now: Date,
  ): Promise<void> {
    const lifecycleActive =
      binding.lifecycle === EdgeCredentialLifecycle.ACTIVE ||
      (binding.lifecycle === EdgeCredentialLifecycle.GRACE &&
        binding.graceExpiresAt !== null &&
        now < binding.graceExpiresAt);
    const timeExpired =
      (binding.expiresAt !== null && now >= binding.expiresAt) ||
      (binding.lifecycle === EdgeCredentialLifecycle.GRACE &&
        binding.graceExpiresAt !== null &&
        now >= binding.graceExpiresAt);
    if (timeExpired) {
      await this.repository.expireCredential(binding.tokenId, now);
    }
    if (
      !lifecycleActive ||
      timeExpired ||
      binding.installationDeactivatedAt !== null ||
      binding.currentGeneration !== binding.enrollmentGeneration ||
      binding.generationState === EdgeInstallationState.REPLACED ||
      binding.generationState === EdgeInstallationState.DEACTIVATED
    ) {
      throw edgeHttpError(403, EDGE_ERROR_CODES.INACTIVE);
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function header(value: string | string[] | undefined): string | null {
  return string(Array.isArray(value) ? value[0] : value);
}
