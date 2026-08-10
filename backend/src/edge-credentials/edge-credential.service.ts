import { Inject, Injectable } from '@nestjs/common';
import { EDGE_CLOCK, type EdgeClock } from './edge-clock.js';
import { EdgeCredentialAuthenticator } from './edge-credential-authenticator.js';
import { bodyHash, generateCredential } from './edge-credential-crypto.js';
import { EdgeCredentialQueryRepository } from './edge-credential-query.repository.js';
import type { EdgeCredentialLifecycleName } from './edge-credential.types.js';
import { EDGE_ERROR_CODES, edgeHttpError } from './edge-errors.js';
import { EdgeIssuanceRepository } from './edge-issuance.repository.js';
import { EdgeLifecycleRepository } from './edge-lifecycle.repository.js';
import {
  EdgeMutationSupport,
  type MutationContext,
} from './edge-mutation-support.js';
import { EdgeReplacementRepository } from './edge-replacement.repository.js';
import { EnrollmentRateLimiter } from './enrollment-rate-limiter.js';
import {
  displayCredential,
  jsonContainsTokenId,
} from './edge-credential-presenter.js';

export type { MutationContext } from './edge-mutation-support.js';

@Injectable()
export class EdgeCredentialService {
  constructor(
    private readonly mutations: EdgeMutationSupport,
    private readonly queries: EdgeCredentialQueryRepository,
    private readonly issuance: EdgeIssuanceRepository,
    private readonly lifecycle: EdgeLifecycleRepository,
    private readonly replacements: EdgeReplacementRepository,
    private readonly authenticator: EdgeCredentialAuthenticator,
    private readonly limiter: EnrollmentRateLimiter,
    @Inject(EDGE_CLOCK) private readonly clock: EdgeClock,
  ) {}

  async issue(
    body: { readonly schemaVersion: 1; readonly facilityId: string },
    context: MutationContext,
  ) {
    const hash = bodyHash(body);
    const replay = await this.mutations.replay(
      context.idempotencyKey,
      'ISSUE',
      hash,
    );
    if (replay !== null) return replay;
    const facility = await this.queries.findFacility(body.facilityId);
    if (facility === null) throw edgeHttpError(403, EDGE_ERROR_CODES.MISMATCH);
    const facilityCode =
      facility.edgeCode ?? (await this.mutations.uniqueFacilityCode());
    const credential = generateCredential(this.mutations.pepper());
    const now = this.clock.now();
    const identity = this.mutations.identity(context, hash, now);
    const created = await this.issuance.issue({
      facilityId: facility.id,
      facilityCode,
      serverRevision: facility.topologyRevision,
      credential,
      now,
      identity,
    });
    return {
      schemaVersion: 1,
      operationId: identity.operationId,
      facilityCode,
      edgeInstallationId: created.edgeInstallationId,
      enrollmentGeneration: 1,
      lifecycle: 'ACTIVE',
      oneTimeDisplay: displayCredential(credential),
      createdAt: now.toISOString(),
    };
  }

  async rotate(
    tokenId: string,
    body: { readonly schemaVersion: 1; readonly expectedLifecycle: 'ACTIVE' },
    context: MutationContext,
  ) {
    const hash = bodyHash({ tokenId, ...body });
    const replay = await this.mutations.replay(
      context.idempotencyKey,
      'ROTATE',
      hash,
    );
    if (replay !== null) return replay;
    const now = this.clock.now();
    const replacement = generateCredential(this.mutations.pepper());
    const result = await this.lifecycle.rotate({
      tokenId,
      replacement,
      now,
      graceEndsAt: new Date(now.getTime() + 86_400_000),
      identity: this.mutations.identity(context, hash, now),
    });
    if (result === null) throw edgeHttpError(409, EDGE_ERROR_CODES.INACTIVE);
    return { ...result.result, oneTimeDisplay: displayCredential(replacement) };
  }

  async revoke(
    tokenId: string,
    body: {
      readonly schemaVersion: 1;
      readonly expectedLifecycle: 'ACTIVE' | 'GRACE';
      readonly reason: string;
    },
    context: MutationContext,
  ) {
    const hash = bodyHash({ tokenId, ...body });
    const replay = await this.mutations.replay(
      context.idempotencyKey,
      'REVOKE',
      hash,
    );
    if (replay !== null) return replay;
    const now = this.clock.now();
    const result = await this.lifecycle.revoke({
      tokenId,
      expectedLifecycle: body.expectedLifecycle,
      reason: body.reason,
      now,
      identity: this.mutations.identity(context, hash, now),
    });
    if (result === null) throw edgeHttpError(409, EDGE_ERROR_CODES.INACTIVE);
    return result;
  }

  async replace(
    edgeInstallationId: string,
    body: {
      readonly schemaVersion: 1;
      readonly expectedEnrollmentGeneration: number;
      readonly newClientInstallationRef: string;
    },
    context: MutationContext,
  ) {
    const hash = bodyHash({ edgeInstallationId, ...body });
    const replay = await this.mutations.replay(
      context.idempotencyKey,
      'REPLACE',
      hash,
    );
    if (replay !== null) return replay;
    const now = this.clock.now();
    const credential = generateCredential(this.mutations.pepper());
    const result = await this.replacements.replace({
      edgeInstallationId,
      expectedGeneration: body.expectedEnrollmentGeneration,
      newClientInstallationRef: body.newClientInstallationRef,
      credential,
      now,
      identity: this.mutations.identity(context, hash, now),
    });
    if (result === null)
      throw edgeHttpError(409, EDGE_ERROR_CODES.STALE_GENERATION);
    return { ...result, oneTimeDisplay: displayCredential(credential) };
  }

  async recoverSecret(
    sourceOperationId: string,
    body: { readonly schemaVersion: 1; readonly expectedTokenId: string },
    context: MutationContext,
  ) {
    const hash = bodyHash({ sourceOperationId, ...body });
    const replay = await this.mutations.replay(
      context.idempotencyKey,
      'RECOVER_SECRET',
      hash,
    );
    if (replay !== null) return replay;
    const source = await this.queries.findOperationById(sourceOperationId);
    if (
      source === null ||
      !['ISSUE', 'ROTATE', 'REPLACE'].includes(source.operationType) ||
      !jsonContainsTokenId(source.redactedResult, body.expectedTokenId)
    ) {
      throw edgeHttpError(409, EDGE_ERROR_CODES.IDEMPOTENCY_CONFLICT);
    }
    const now = this.clock.now();
    const replacement = generateCredential(this.mutations.pepper());
    const result = await this.lifecycle.recover({
      lostTokenId: body.expectedTokenId,
      replacement,
      now,
      identity: this.mutations.identity(context, hash, now),
    });
    if (result === null) throw edgeHttpError(409, EDGE_ERROR_CODES.INACTIVE);
    return { ...result, oneTimeDisplay: displayCredential(replacement) };
  }

  async verify(input: {
    readonly fullToken: string;
    readonly sourceIp: string;
    readonly facilityCode: string;
    readonly clientInstallationRef: string;
  }) {
    if (!this.limiter.consume(input.sourceIp, input.facilityCode)) {
      throw edgeHttpError(429, EDGE_ERROR_CODES.RATE_LIMITED, true);
    }
    const authenticated = await this.authenticator.authenticateForEnrollment(
      input.fullToken,
    );
    if (authenticated.binding.facilityCode !== input.facilityCode) {
      throw edgeHttpError(401, EDGE_ERROR_CODES.INVALID);
    }
    const generation = await this.queries.claim(
      authenticated.binding,
      input.clientInstallationRef,
      this.clock.now(),
    );
    if (generation.clientInstallationRef !== input.clientInstallationRef) {
      throw edgeHttpError(409, EDGE_ERROR_CODES.INSTALLATION_CONFLICT);
    }
    return {
      schemaVersion: 1,
      edgeInstallationId: authenticated.principal.edgeInstallationId,
      enrollmentGeneration: authenticated.principal.enrollmentGeneration,
      facility: {
        id: authenticated.principal.facilityId,
        displayName: authenticated.binding.facilityName,
      },
      serverRevision: authenticated.binding.serverRevision,
    };
  }

  async list(facilityId?: string, lifecycle?: EdgeCredentialLifecycleName) {
    const credentials = await this.queries.list(facilityId, lifecycle);
    return {
      schemaVersion: 1,
      items: credentials.map((credential) => ({
        tokenId: credential.tokenId,
        prefix: credential.tokenPrefix,
        lifecycle: credential.lifecycle,
        edgeInstallationId: credential.edgeInstallationId,
        enrollmentGeneration: credential.enrollmentGeneration,
        createdAt: credential.issuedAt.toISOString(),
        valueState: 'not-returned',
      })),
    };
  }
}
