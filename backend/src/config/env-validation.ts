const REQUIRED_PROD_ENV = [
  'DATABASE_URL',
  'DIRECT_URL',
  'FRONT_ORIGIN',
  'ALERT_DASHBOARD_URL',
  'SESSION_JWT_SECRET',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'EDGE_TOKEN_PEPPER',
] as const;

const LOCAL_ONLY_VALUES = [
  'dev-only-session-secret-change-me-32chars-min',
] as const;

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
  validateSessionSecret(config, errors);
  validateBooleanFlag(config, 'AUTH_COOKIE_SECURE', errors);
  validateBooleanFlag(config, 'SMTP_SECURE', errors);

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

function validateBooleanFlag(
  config: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const value = stringValue(config, key);
  if (value === undefined) {
    return;
  }
  if (value !== 'true' && value !== 'false') {
    errors.push(`${key} must be either true or false`);
  }
}
