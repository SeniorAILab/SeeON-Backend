import { readFileSync } from 'node:fs';
import {
  canonicalizeJson,
  FixtureContractError,
  sha256CanonicalJson,
  type JsonObject,
  type JsonValue,
} from './edge-contract-jcs.js';

export {
  canonicalizeJson,
  FixtureContractError,
  sha256CanonicalJson,
  type JsonObject,
  type JsonValue,
} from './edge-contract-jcs.js';

export const EDGE_PROVISIONING_FIXTURE_SHA256 =
  '5e64609fdeba5968864b9c78807ae71864a54143c70bffb82924788957c3f2ff';

export type LoadedEdgeProvisioningFixtures = {
  readonly document: JsonObject;
  readonly canonical: string;
  readonly digest: string;
};

export function loadEdgeProvisioningFixtures(
  fixturesPath: string,
): LoadedEdgeProvisioningFixtures {
  const parsed: unknown = JSON.parse(readFileSync(fixturesPath, 'utf8'));
  const document = parseEdgeProvisioningFixtures(parsed);
  const digest = sha256CanonicalJson(omitCanonicalDigest(document));
  const metadata = readObject(document.metadata, 'metadata');
  const recordedDigest = readString(
    metadata.canonicalSha256,
    'metadata.canonicalSha256',
  );
  if (
    digest !== recordedDigest ||
    digest !== EDGE_PROVISIONING_FIXTURE_SHA256
  ) {
    throw new FixtureContractError('canonical fixture digest mismatch');
  }
  return {
    document,
    canonical: canonicalizeJson(omitCanonicalDigest(document)),
    digest,
  };
}

export function parseEdgeProvisioningFixtures(input: unknown): JsonObject {
  const document = toJsonObject(input, 'fixture corpus');
  const metadata = readObject(document.metadata, 'metadata');
  expectValue(
    metadata.sourceVersion,
    'edge-provisioning-v1',
    'metadata.sourceVersion',
  );
  expectValue(
    metadata.canonicalization,
    'RFC 8785 JSON Canonicalization Scheme (JCS)',
    'metadata.canonicalization',
  );
  expectValue(metadata.digestAlgorithm, 'SHA-256', 'metadata.digestAlgorithm');
  const digest = readString(
    metadata.canonicalSha256,
    'metadata.canonicalSha256',
  );
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new FixtureContractError(
      'metadata.canonicalSha256 must be lowercase hex',
    );
  }
  validateHappyFixtures(readObject(document.happy, 'happy'));
  validateRejections(readObject(document.rejections, 'rejections'));
  return document;
}

export function assertFrozenSuccessEnvelope(value: unknown): void {
  const envelope = toJsonObject(value, 'success envelope');
  expectValue(envelope.schemaVersion, 1, 'success envelope.schemaVersion');
  for (const key of [
    'snapshotId',
    'clientRevision',
    'serverRevision',
    'result',
  ]) {
    if (!Object.hasOwn(envelope, key)) {
      throw new FixtureContractError(`success envelope.${key} is required`);
    }
  }
}

export function assertFrozenErrorEnvelope(value: unknown): void {
  const envelope = toJsonObject(value, 'error envelope');
  expectValue(envelope.schemaVersion, 1, 'error envelope.schemaVersion');
  const error = readObject(envelope.error, 'error envelope.error');
  readString(error.code, 'error envelope.error.code');
  readString(error.message, 'error envelope.error.message');
  if (typeof error.retryable !== 'boolean') {
    throw new FixtureContractError(
      'error envelope.error.retryable must be boolean',
    );
  }
  readString(error.requestId, 'error envelope.error.requestId');
}

function validateHappyFixtures(happy: JsonObject): void {
  if (Object.keys(happy).length === 0) {
    throw new FixtureContractError('happy fixtures must not be empty');
  }
  for (const [name, value] of Object.entries(happy)) {
    const fixture = toJsonObject(value, `happy.${name}`);
    readString(fixture.method, `happy.${name}.method`);
    readString(fixture.path, `happy.${name}.path`);
    readString(fixture.successStatus, `happy.${name}.successStatus`);
    readObject(fixture.request, `happy.${name}.request`);
    readObject(fixture.response, `happy.${name}.response`);
  }
}

function validateRejections(rejections: JsonObject): void {
  if (Object.keys(rejections).length === 0) {
    throw new FixtureContractError('rejection fixtures must not be empty');
  }
  for (const [name, value] of Object.entries(rejections)) {
    const rejection = toJsonObject(value, `rejections.${name}`);
    expectValue(rejection.valid, false, `rejections.${name}.valid`);
    const error = readObject(rejection.error, `rejections.${name}.error`);
    readString(error.code, `rejections.${name}.error.code`);
    readString(error.message, `rejections.${name}.error.message`);
    if (typeof error.retryable !== 'boolean') {
      throw new FixtureContractError(
        `rejections.${name}.error.retryable must be boolean`,
      );
    }
    readString(error.requestId, `rejections.${name}.error.requestId`);
  }
}

function omitCanonicalDigest(document: JsonObject): JsonObject {
  const metadata = readObject(document.metadata, 'metadata');
  const withoutDigest: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key !== 'canonicalSha256') withoutDigest[key] = value;
  }
  return { ...document, metadata: withoutDigest };
}

function toJsonObject(value: unknown, label: string): JsonObject {
  const json = toJsonValue(value, label);
  if (!isJsonObject(json))
    throw new FixtureContractError(`${label} must be an object`);
  return json;
}

function toJsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new FixtureContractError(`${label} is non-finite`);
    return value;
  }
  if (typeof value === 'string') return checkedString(value, label);
  if (Array.isArray(value))
    return value.map((item, index) => toJsonValue(item, `${label}[${index}]`));
  if (typeof value !== 'object')
    throw new FixtureContractError(`${label} is not JSON`);
  const record: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    record[checkedString(key, `${label} key`)] = toJsonValue(
      nested,
      `${label}.${key}`,
    );
  }
  return record;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readObject(value: JsonValue, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new FixtureContractError(`${label} must be an object`);
  }
  return value;
}

function readString(value: JsonValue, label: string): string {
  if (typeof value !== 'string')
    throw new FixtureContractError(`${label} must be a string`);
  return value;
}

function expectValue(
  actual: JsonValue | undefined,
  expected: JsonValue,
  label: string,
): void {
  if (actual !== expected)
    throw new FixtureContractError(`${label} is invalid`);
}

function checkedString(value: string, label: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    const isHighSurrogate = codePoint >= 0xd800 && codePoint <= 0xdbff;
    const isLowSurrogate = codePoint >= 0xdc00 && codePoint <= 0xdfff;
    if (
      isHighSurrogate &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      index += 1;
      continue;
    }
    if (isHighSurrogate || isLowSurrogate) {
      throw new FixtureContractError(`${label} contains an unpaired surrogate`);
    }
  }
  return value;
}
