import {
  FrontendOriginsValidationError,
  parseFrontendOrigins,
} from './frontend-origins.js';

const REQUIRED_PROD_ENV = [
  'DATABASE_URL',
  'DIRECT_URL',
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
const TEMPORARY_BRIDGE_ORIGIN = 'https://seeon-front.vercel.app';

export class BackendEnvValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`Invalid backend production env:\n${errors.join('\n')}`);
    this.name = 'BackendEnvValidationError';
  }
}

export function validateBackendEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];
  validateFrontendOrigins(config, errors);
  validateCookieSecurityMode(config, errors);
  validateCookieSameSiteMode(config, errors);

  if (stringValue(config, 'NODE_ENV') === 'production') {
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

    validateUrl(config, 'ALERT_DASHBOARD_URL', errors);
    validateSessionSecret(config, errors);
    validateBooleanFlag(config, 'SMTP_SECURE', errors);
  }

  if (errors.length > 0) {
    throw new BackendEnvValidationError(errors);
  }
  if (cookieSameSiteMode(config) === 'none') {
    console.warn(
      'WARNING: temporary cross-site auth bridge enabled; third-party cookie blocking is unsupported',
    );
  }
  return config;
}

function validateFrontendOrigins(
  config: Record<string, unknown>,
  errors: string[],
): void {
  try {
    parseFrontendOrigins(config);
  } catch (error) {
    if (error instanceof FrontendOriginsValidationError) {
      errors.push(...error.errors);
      return;
    }
    throw error;
  }
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

function validateCookieSecurityMode(
  config: Record<string, unknown>,
  errors: string[],
): void {
  const value = stringValue(config, 'AUTH_COOKIE_SECURE');
  if (value === undefined) {
    return;
  }
  if (value !== 'true' && value !== 'false' && value !== 'auto') {
    errors.push('AUTH_COOKIE_SECURE must be true, false, or auto');
  }
}

function validateCookieSameSiteMode(
  config: Record<string, unknown>,
  errors: string[],
): void {
  const configured = stringValue(config, 'AUTH_COOKIE_SAME_SITE');
  if (configured !== undefined && configured !== 'strict' && configured !== 'none') {
    errors.push('AUTH_COOKIE_SAME_SITE must be strict or none');
    return;
  }
  if (cookieSameSiteMode(config) !== 'none') {
    return;
  }
  if (stringValue(config, 'NODE_ENV') !== 'production') {
    errors.push('AUTH_COOKIE_SAME_SITE=none is allowed only in production');
  }
  if (stringValue(config, 'AUTH_COOKIE_SECURE') !== 'true') {
    errors.push('AUTH_COOKIE_SAME_SITE=none requires AUTH_COOKIE_SECURE=true');
  }
  if (!Object.prototype.hasOwnProperty.call(config, 'FRONT_ORIGINS')) {
    errors.push('AUTH_COOKIE_SAME_SITE=none requires explicit FRONT_ORIGINS');
    return;
  }
  try {
    const origins = parseFrontendOrigins(config);
    if (origins.length !== 1 || origins[0] !== TEMPORARY_BRIDGE_ORIGIN) {
      errors.push(
        'AUTH_COOKIE_SAME_SITE=none requires the exact temporary bridge origin',
      );
    }
  } catch {
    // validateFrontendOrigins already reports the precise malformed-origin error.
  }
}

function cookieSameSiteMode(
  config: Record<string, unknown>,
): 'strict' | 'none' {
  return stringValue(config, 'AUTH_COOKIE_SAME_SITE') === 'none'
    ? 'none'
    : 'strict';
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
