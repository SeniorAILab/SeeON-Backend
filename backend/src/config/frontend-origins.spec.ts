import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FrontendOriginsValidationError,
  parseFrontendOrigins,
} from './frontend-origins.js';

type OriginConformanceVectors = {
  readonly validProduction: readonly {
    readonly name: string;
    readonly value: string;
    readonly canonical: readonly string[];
  }[];
  readonly invalidProduction: readonly {
    readonly name: string;
    readonly value: string;
  }[];
};

const vectors = JSON.parse(
  readFileSync(join(__dirname, 'frontend-origin-conformance.json'), 'utf8'),
) as OriginConformanceVectors;

describe('parseFrontendOrigins', () => {
  it.each(vectors.validProduction)(
    'accepts shared production vector: $name',
    ({ value, canonical }) => {
      expect(
        parseFrontendOrigins({
          NODE_ENV: 'production',
          FRONT_ORIGINS: value,
        }),
      ).toEqual(canonical);
    },
  );

  it.each(vectors.invalidProduction)(
    'rejects shared production vector: $name',
    ({ value }) => {
      expect(() =>
        parseFrontendOrigins({
          NODE_ENV: 'production',
          FRONT_ORIGINS: value,
        }),
      ).toThrow(FrontendOriginsValidationError);
    },
  );

  it('uses FRONT_ORIGIN only when FRONT_ORIGINS is absent', () => {
    expect(
      parseFrontendOrigins({
        FRONT_ORIGIN: 'http://localhost:3000',
      }),
    ).toEqual(['http://localhost:3000']);

    expect(() =>
      parseFrontendOrigins({
        FRONT_ORIGINS: '*, ,',
        FRONT_ORIGIN: 'https://seeon.seniorsailab.com',
      }),
    ).toThrow(FrontendOriginsValidationError);
  });

  it('permits localhost only outside production', () => {
    expect(
      parseFrontendOrigins({
        NODE_ENV: 'development',
        FRONT_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000',
      }),
    ).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);

    expect(() =>
      parseFrontendOrigins({
        NODE_ENV: 'production',
        FRONT_ORIGINS: 'http://localhost:3000',
      }),
    ).toThrow('FRONT_ORIGINS must not use localhost or loopback in production');
  });

  it.each([
    ['wildcard', '*'],
    ['non-http protocol', 'ftp://seeon.seniorsailab.com'],
    ['userinfo', 'https://user:pass@seeon.seniorsailab.com'],
    ['non-root path', 'https://seeon.seniorsailab.com/api'],
    ['query', 'https://seeon.seniorsailab.com/?next=evil'],
    ['hash', 'https://seeon.seniorsailab.com/#evil'],
    ['invalid URL', 'not a URL'],
  ])('rejects %s entries', (_label, value) => {
    expect(() => parseFrontendOrigins({ FRONT_ORIGINS: value })).toThrow(
      FrontendOriginsValidationError,
    );
  });

  it('rejects an empty production origin set', () => {
    expect(() =>
      parseFrontendOrigins({ NODE_ENV: 'production', FRONT_ORIGINS: ' , ' }),
    ).toThrow('At least one frontend origin is required in production');
  });
});
