const FRONT_ORIGINS_KEY = 'FRONT_ORIGINS';
const FRONT_ORIGIN_KEY = 'FRONT_ORIGIN';
const ABSOLUTE_URL_SYNTAX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]*)(.*)$/u;

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

  let entries: string[] = [];
  if (typeof rawValue === 'string') {
    if (containsControlCharacter(rawValue)) {
      errors.push(`${sourceKey} must not contain control characters`);
    }
    const members = rawValue.split(',');
    if (members.some((entry) => entry.trim().length === 0)) {
      errors.push(`${sourceKey} must not contain empty members`);
    }
    entries = members
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  const origins: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const origin = parseExactOrigin(entry, sourceKey, config, errors);
    if (origin === undefined) continue;
    if (seen.has(origin)) {
      errors.push(
        `${sourceKey} must not contain canonical duplicates: ${origin}`,
      );
      continue;
    }
    seen.add(origin);
    origins.push(origin);
  }

  if (isProduction(config) && origins.length === 0) {
    errors.push('At least one frontend origin is required in production');
  }

  if (errors.length > 0) {
    throw new FrontendOriginsValidationError(errors);
  }
  return origins;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
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
  const initialErrorCount = errors.length;
  if (entry === '*') {
    errors.push(`${sourceKey} must not contain a wildcard origin`);
    return undefined;
  }
  if (entry.includes('\\')) {
    errors.push(`${sourceKey} origins must not contain backslashes: ${entry}`);
    return undefined;
  }
  if (entry.includes('?')) {
    errors.push(`${sourceKey} origins must not contain a query: ${entry}`);
  }
  if (entry.includes('#')) {
    errors.push(`${sourceKey} origins must not contain a hash: ${entry}`);
  }

  const syntax = ABSOLUTE_URL_SYNTAX.exec(entry);
  if (syntax === null) {
    errors.push(`${sourceKey} contains an invalid URL: ${entry}`);
    return undefined;
  }
  const syntacticPath = syntax[2];
  if (syntacticPath !== '' && syntacticPath !== '/') {
    errors.push(`${sourceKey} origins must not contain a path: ${entry}`);
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
  if (url.hostname.includes('*')) {
    errors.push(`${sourceKey} must not contain a wildcard host: ${entry}`);
  }
  if (url.pathname !== '/') {
    errors.push(`${sourceKey} origins must not contain a path: ${entry}`);
  }
  if (isProduction(config) && isLocalHostname(url.hostname)) {
    errors.push(
      `${sourceKey} must not use localhost or loopback in production`,
    );
  }

  return errors.length === initialErrorCount ? url.origin : undefined;
}

function isProduction(config: Record<string, unknown>): boolean {
  return config.NODE_ENV === 'production';
}

function isLocalHostname(hostname: string): boolean {
  const canonical = hostname.toLowerCase().replace(/\.+$/u, '');
  return (
    canonical === 'localhost' ||
    canonical.endsWith('.localhost') ||
    canonical.startsWith('127.') ||
    canonical === '[::1]' ||
    canonical.startsWith('[::ffff:7f')
  );
}
