import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { GeneratedCredential } from './edge-credential.types.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateFacilityCode(): string {
  return `NH-${randomCrockford(10)}`;
}

export function generateCredential(pepper: string): GeneratedCredential {
  const tokenId = randomCrockford(12);
  const fullToken = `eft_v1.${tokenId}.${randomBytes(32).toString('base64url')}`;
  return {
    tokenId,
    fullToken,
    digest: tokenDigest(pepper, fullToken).toString('hex'),
    prefix: `eft_v1.${tokenId}`,
  };
}

export function tokenDigest(pepper: string, fullToken: string): Buffer {
  return createHmac('sha256', pepper).update(fullToken).digest();
}

export function bodyHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function uuidV7(now: number): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(now);
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 255n);
  }
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomCrockford(length: number): string {
  return [...randomBytes(length)]
    .map((value) => CROCKFORD.charAt(value & 31))
    .join('');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
