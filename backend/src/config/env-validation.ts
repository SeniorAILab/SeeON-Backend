const REQUIRED_PROD_ENV = [
  'DATABASE_URL',
  'DIRECT_URL',
  'FRONT_ORIGIN',
  'ALERT_DASHBOARD_URL',
  'KAKAO_REST_API_KEY',
  'KAKAO_REDIRECT_URI',
  'SESSION_JWT_SECRET',
  'KAKAO_TOKEN_ENC_KEY',
] as const;

const LOCAL_ONLY_VALUES = [
  'dev-placeholder-kakao-rest-api-key',
  'dev-only-session-secret-change-me-32chars-min',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
] as const;

const TOKEN_KEY_BYTES = 32;

export class BackendEnvValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`Invalid backend production env:\n${errors.join('\n')}`);
    this.name = 'BackendEnvValidationError';
  }
}

export function validateBackendEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (stringValue(config, 'NODE_ENV') !== 'production') {
    return config;
  }

  const errors: string[] = [];
  for (const key of REQUIRED_PROD_ENV) {
    const value = stringValue(config, key);
    if (value === undefined) {
      errors.push(`${key} is required in production`);
    } else if (
      LOCAL_ONLY_VALUES.some((localOnlyValue) => localOnlyValue === value)
    ) {
      errors.push(`${key} must not use a local development placeholder`);
    }
  }

  validateUrl(config, 'FRONT_ORIGIN', errors);
  validateUrl(config, 'ALERT_DASHBOARD_URL', errors);
  validateUrl(config, 'KAKAO_REDIRECT_URI', errors);
  validateSessionSecret(config, errors);
  validateKakaoTokenKey(config, errors);

  if (errors.length > 0) {
    throw new BackendEnvValidationError(errors);
  }
  return config;
}

function stringValue(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateUrl(
  config: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const value = stringValue(config, key);
  if (value === undefined) {
    return;
  }
  try {
    const url = new URL(value);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      errors.push(`${key} must not use localhost in production`);
    }
  } catch {
    errors.push(`${key} must be a valid URL`);
  }
}

function validateSessionSecret(
  config: Record<string, unknown>,
  errors: string[],
): void {
  const value = stringValue(config, 'SESSION_JWT_SECRET');
  if (value !== undefined && value.length < 32) {
    errors.push('SESSION_JWT_SECRET must be at least 32 characters');
  }
}

function validateKakaoTokenKey(
  config: Record<string, unknown>,
  errors: string[],
): void {
  const value = stringValue(config, 'KAKAO_TOKEN_ENC_KEY');
  if (value === undefined) {
    return;
  }
  if (decodeKey(value).length !== TOKEN_KEY_BYTES) {
    errors.push('KAKAO_TOKEN_ENC_KEY must decode to exactly 32 bytes');
  }
}

function decodeKey(encodedKey: string): Buffer {
  const trimmed = encodedKey.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, 'hex');
  }
  return Buffer.from(trimmed, 'base64');
}
