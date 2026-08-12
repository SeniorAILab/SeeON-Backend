const FRONT_ORIGINS_KEY = 'FRONT_ORIGINS';
const FRONT_ORIGIN_KEY = 'FRONT_ORIGIN';

export class FrontendOriginsValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(errors.join('\n'));
    this.name = 'FrontendOriginsValidationError';
  }
}

export function parseFrontendOrigins(
  config: Record<string, unknown>,
): readonly string[] {
  const sourceKey = hasConfiguredPlural(config)
    ? FRONT_ORIGINS_KEY
    : FRONT_ORIGIN_KEY;
  const rawValue = config[sourceKey];
  const errors: string[] = [];

  if (rawValue !== undefined && typeof rawValue !== 'string') {
    errors.push(`${sourceKey} must be a comma-separated string`);
  }

  const entries =
    typeof rawValue === 'string'
      ? rawValue
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
  const origins: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const origin = parseExactOrigin(entry, sourceKey, config, errors);
    if (origin !== undefined && !seen.has(origin)) {
      seen.add(origin);
      origins.push(origin);
    }
  }

  if (isProduction(config) && origins.length === 0) {
    errors.push('At least one frontend origin is required in production');
  }

  if (errors.length > 0) {
    throw new FrontendOriginsValidationError(errors);
  }
  return origins;
}

function hasConfiguredPlural(config: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(config, FRONT_ORIGINS_KEY);
}

function parseExactOrigin(
  entry: string,
  sourceKey: string,
  config: Record<string, unknown>,
  errors: string[],
): string | undefined {
  if (entry === '*') {
    errors.push(`${sourceKey} must not contain a wildcard origin`);
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    errors.push(`${sourceKey} contains an invalid URL: ${entry}`);
    return undefined;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push(`${sourceKey} origins must use http or https: ${entry}`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    errors.push(`${sourceKey} origins must not contain userinfo: ${entry}`);
  }
  if (url.pathname !== '/') {
    errors.push(`${sourceKey} origins must not contain a path: ${entry}`);
  }
  if (url.search.length > 0) {
    errors.push(`${sourceKey} origins must not contain a query: ${entry}`);
  }
  if (url.hash.length > 0) {
    errors.push(`${sourceKey} origins must not contain a hash: ${entry}`);
  }
  if (isProduction(config) && isLocalHostname(url.hostname)) {
    errors.push(`${sourceKey} must not use localhost in production`);
  }

  return errors.length === 0 ? url.origin : undefined;
}

function isProduction(config: Record<string, unknown>): boolean {
  return config.NODE_ENV === 'production';
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  );
}
