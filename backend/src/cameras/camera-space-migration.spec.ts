import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('camera_space_expand migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../prisma/migrations/20260622130000_camera_space_expand/migration.sql',
    ),
    'utf8',
  );

  it('adds Camera.spaceId with composite FK, unique, and ingest lookup output', () => {
    expect(sql).toContain('ALTER TABLE cameras ADD COLUMN space_id TEXT');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX cameras_facility_id_space_id_key ON cameras(facility_id, space_id)',
    );
    expect(sql).toContain(
      'FOREIGN KEY (facility_id, space_id) REFERENCES spaces(facility_id, id)',
    );
    expect(sql).toContain('"spaceId" TEXT');
    expect(sql).toContain('space_id AS "spaceId"');
  });

  it('blocks duplicate, missing, stale, and cross-facility legacy camera claims', () => {
    expect(sql).toContain('duplicate_same_facility');
    expect(sql).toContain('missing_claim');
    expect(sql).toContain('stale_claim');
    expect(sql).toContain('cross_facility_claim');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain(
      'this migration never auto-fills from resident placement',
    );
  });

  it('preserves cameras RLS and fall_app grants', () => {
    expect(sql).toContain('ALTER TABLE cameras ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE cameras FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON cameras TO fall_app',
    );
  });
});

describe('camera_space_contract migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../prisma/migrations/20260622140000_camera_space_contract/migration.sql',
    ),
    'utf8',
  );

  it('blocks NOT NULL enforcement when any camera lacks space_id', () => {
    expect(sql).toContain('SELECT count(*) INTO null_camera_space_count');
    expect(sql).toContain('FROM cameras');
    expect(sql).toContain('WHERE space_id IS NULL');
    expect(sql).toContain('RAISE EXCEPTION');
  });

  it('sets cameras.space_id NOT NULL and keeps final unique index', () => {
    expect(sql).toContain(
      'ALTER TABLE cameras ALTER COLUMN space_id SET NOT NULL',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS cameras_facility_id_space_id_key ON cameras(facility_id, space_id)',
    );
  });

  it('removes residentId from ingest lookup output and preserves RLS/grants', () => {
    expect(sql).toContain('"spaceId" TEXT');
    expect(sql).not.toContain('"residentId"');
    expect(sql).not.toContain('resident_id AS');
    expect(sql).toContain('ALTER TABLE cameras ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE cameras FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON cameras TO fall_app',
    );
  });
});
