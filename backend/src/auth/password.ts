import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

const KEY_LENGTH = 64;
const PARAM_N = 16384;
const PARAM_R = 8;
const PARAM_P = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derived = await deriveScryptKey(password, salt, KEY_LENGTH, {
    N: PARAM_N,
    r: PARAM_R,
    p: PARAM_P,
  });
  return `scrypt$${PARAM_N}$${PARAM_R}$${PARAM_P}$${salt}$${derived.toString('base64url')}`;
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) return false;
  const candidate = await deriveScryptKey(
    password,
    parsed.salt,
    parsed.hash.length,
    {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
    },
  );
  return (
    candidate.length === parsed.hash.length &&
    timingSafeEqual(candidate, parsed.hash)
  );
}

function parsePasswordHash(
  encodedHash: string,
): { n: number; r: number; p: number; salt: string; hash: Buffer } | null {
  const [algorithm, rawN, rawR, rawP, salt, rawHash] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !salt || !rawHash) return null;
  const n = Number.parseInt(rawN, 10);
  const r = Number.parseInt(rawR, 10);
  const p = Number.parseInt(rawP, 10);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null;
  }
  return { n, r, p, salt, hash: Buffer.from(rawHash, 'base64url') };
}

function deriveScryptKey(
  password: string,
  salt: string,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}
