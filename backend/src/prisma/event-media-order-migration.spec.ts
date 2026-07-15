import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationPath = join(
  __dirname,
  '../../prisma/migrations/20260716153000_event_media_binding_order/migration.sql',
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8')
  : '';
const schema = readFileSync(
  join(__dirname, '../../prisma/schema.prisma'),
  'utf8',
);
const restoreHarness = readFileSync(
  join(
    __dirname,
    '../../../scripts/deploy/event-media-product-restore-harness.test.sh',
  ),
  'utf8',
);

describe('ordered event media binding migration', () => {
  it('persists an ordinal with one position per facility clip', () => {
    // Given: event_refs order is part of immutable clip identity.
    // When: the Prisma model and forward migration are inspected.
    // Then: ordinal is required, non-negative, and unique per clip.
    expect(schema).toMatch(/ordinal\s+Int\s+@map\("ordinal"\)/);
    expect(schema).toContain('@@unique([facilityId, clipId, ordinal])');
    expect(migration).toContain(
      'ALTER TABLE event_media_bindings ADD COLUMN ordinal INTEGER;',
    );
    expect(migration).toContain('PARTITION BY facility_id, clip_id');
    expect(migration).toContain('ALTER COLUMN ordinal SET NOT NULL');
    expect(migration).toContain('CHECK (ordinal >= 0)');
    expect(migration).toContain(
      'event_media_bindings_facility_id_clip_id_ordinal_key',
    );
  });

  it('adds a durable READY staging token without replacing policy', () => {
    // Given: DB reservation must survive process failure and remain retryable.
    // When: the Prisma model and additive migration are inspected.
    // Then: the token is a nullable immutable SHA-256 identity fence.
    expect(schema).toMatch(
      /stagingToken\s+String\?\s+@map\("staging_token"\)\s+@db\.Char\(64\)/,
    );
    expect(migration).toContain(
      'ALTER TABLE media_clips ADD COLUMN staging_token CHAR(64);',
    );
    expect(migration).toContain('media_clips_staging_token_check');
  });

  it('keeps the migration additive and tenant policy intact', () => {
    // Given: existing bindings and RLS policy must survive the correction.
    // When: the forward migration is inspected for destructive operations.
    // Then: no table/column/policy is dropped or RLS disabled.
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN|POLICY)/i);
    expect(migration).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(migration).not.toMatch(/REVOKE/i);
  });

  it('updates the product restore fixture with explicit binding order', () => {
    // Given: restored rows must satisfy the new NOT NULL contract.
    // When: the product restore fixture inserts an event binding.
    // Then: it supplies ordinal explicitly instead of relying on a default.
    expect(restoreHarness).toContain(
      'INSERT INTO event_media_bindings (event_id, facility_id, clip_id, ordinal, created_at)',
    );
    expect(restoreHarness).toContain(
      "VALUES ('restore_event_a', 'restore_facility_a', 'restore_clip_a', 0, '2026-07-16T01:02:07Z');",
    );
  });
});
