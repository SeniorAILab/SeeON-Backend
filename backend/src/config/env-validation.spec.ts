import {
  BackendEnvValidationError,
  validateBackendEnv,
} from './env-validation.js';

const VALID_PROD_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://fall_app_prod:app-pass@db:5432/fall_prod',
  DIRECT_URL: 'postgresql://fall_prod_admin:admin-pass@db:5432/fall_prod',
  FRONT_ORIGIN: 'https://senai.example.com',
  ALERT_DASHBOARD_URL: 'https://senai.example.com',
  SESSION_JWT_SECRET: 'prod-dummy-session-secret-minimum-32-chars',
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'alerts@example.com',
  SMTP_PASSWORD: 'prod-smtp-password',
  EDGE_TOKEN_PEPPER: 'prod-dummy-edge-token-pepper',
} as const;

describe('validateBackendEnv', () => {
  it('allows local development placeholders when NODE_ENV is not production', () => {
    const env = {
      NODE_ENV: 'development',
      SESSION_JWT_SECRET: 'short',
    };

    expect(validateBackendEnv(env)).toBe(env);
  });

  it('accepts a complete production environment', () => {
    expect(validateBackendEnv(VALID_PROD_ENV)).toBe(VALID_PROD_ENV);
  });

  it('accepts an explicit production secure-cookie override', () => {
    const env = {
      ...VALID_PROD_ENV,
      AUTH_COOKIE_SECURE: 'false',
    };

    expect(validateBackendEnv(env)).toBe(env);
  });

  it('rejects missing production values', () => {
    const env: Record<string, string> = { ...VALID_PROD_ENV };
    delete env.SMTP_HOST;

    expect(() => validateBackendEnv(env)).toThrow(
      new BackendEnvValidationError(['SMTP_HOST is required in production']),
    );
  });

  it('rejects local placeholders in production', () => {
    const env = {
      ...VALID_PROD_ENV,
      SESSION_JWT_SECRET: 'dev-only-session-secret-change-me-32chars-min',
    };

    expect(() => validateBackendEnv(env)).toThrow(BackendEnvValidationError);
  });

  it('rejects localhost URLs in production', () => {
    const env = {
      ...VALID_PROD_ENV,
      FRONT_ORIGIN: 'http://localhost:3000',
    };

    expect(() => validateBackendEnv(env)).toThrow(BackendEnvValidationError);
  });

  it('rejects invalid production secrets', () => {
    const env = {
      ...VALID_PROD_ENV,
      SESSION_JWT_SECRET: 'short',
    };

    expect(() => validateBackendEnv(env)).toThrow(BackendEnvValidationError);
  });

  it('rejects malformed production boolean flags', () => {
    const env = {
      ...VALID_PROD_ENV,
      AUTH_COOKIE_SECURE: '0',
    };

    expect(() => validateBackendEnv(env)).toThrow(
      new BackendEnvValidationError([
        'AUTH_COOKIE_SECURE must be either true or false',
      ]),
    );
  });

  it('rejects a malformed SMTP_SECURE boolean flag', () => {
    const env = {
      ...VALID_PROD_ENV,
      SMTP_SECURE: 'yes',
    };

    expect(() => validateBackendEnv(env)).toThrow(
      new BackendEnvValidationError([
        'SMTP_SECURE must be either true or false',
      ]),
    );
  });

  it('accepts a valid SMTP_SECURE boolean flag', () => {
    const env = {
      ...VALID_PROD_ENV,
      SMTP_SECURE: 'true',
    };

    expect(validateBackendEnv(env)).toBe(env);
  });
});
