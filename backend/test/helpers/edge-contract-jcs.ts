import { createHash } from 'node:crypto';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export class FixtureContractError extends Error {
  readonly name = 'FixtureContractError';

  constructor(readonly detail: string) {
    super(detail);
  }
}

export function canonicalizeJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonicalString(key)}:${canonicalizeJson(value[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new FixtureContractError(
      'non-finite numbers are not valid JCS values',
    );
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return canonicalString(value);
  }
  throw new FixtureContractError('value is not valid JCS JSON');
}

export function sha256CanonicalJson(value: JsonValue): string {
  return createHash('sha256').update(canonicalizeJson(value)).digest('hex');
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalString(value: JsonPrimitive): string {
  const scalar =
    typeof value === 'string' ? checkedString(value, 'string') : value;
  return JSON.stringify(scalar);
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
