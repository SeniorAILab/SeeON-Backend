import type { Prisma } from '@prisma/client';

export function displayCredential(credential: {
  readonly tokenId: string;
  readonly prefix: string;
  readonly fullToken: string;
}) {
  return {
    redacted: false,
    tokenId: credential.tokenId,
    prefix: credential.prefix,
    value: credential.fullToken,
  };
}

export function jsonContainsTokenId(
  value: Prisma.JsonValue | null,
  tokenId: string,
): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsTokenId(item, tokenId));
  }
  return Object.entries(value).some(([key, item]) => {
    if (key === 'tokenId' && item === tokenId) return true;
    return item !== undefined && jsonContainsTokenId(item, tokenId);
  });
}
