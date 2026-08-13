import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_DIRECTORY = '20260716120000_event_clip_media_schema';
const migrationPath = join(
  __dirname,
  '../../prisma/migrations',
  MIGRATION_DIRECTORY,
  'migration.sql',
);
const schema = readFileSync(
  join(__dirname, '../../prisma/schema.prisma'),
  'utf8',
);
const prismaService = readFileSync(
  join(__dirname, 'prisma.service.ts'),
  'utf8',
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8')
  : '';

describe('event clip media expand migration', () => {
  it('adds stable edge event identity while preserving legacy clip identity', () => {
    // Given: the immutable Event model and its legacy rollback column.
    // When: the event-clip schema is inspected.
    // Then: producer identity is tenant-unique and the old column remains.
    expect(schema).toMatch(
      /edgeEventId\s+String\?[^\n]*@map\("edge_event_id"\)[^\n]*@db\.Uuid/,
    );
    expect(schema).toContain('@@unique([facilityId, edgeEventId])');
    expect(schema).toContain('clipId             String?  @map("clip_id")');
    expect(migration).toContain(
      'ALTER TABLE events ADD COLUMN edge_event_id UUID;',
    );
    expect(migration).toContain(
      'ALTER TABLE events ADD CONSTRAINT events_edge_event_id_v4_check',
    );
    expect(migration).not.toMatch(/DROP\s+(?:COLUMN|TABLE)/i);
  });

  it('models one clip for many events with at most one binding per event', () => {
    // Given: clips may coalesce multiple edge events.
    // When: the authoritative aggregate shape is inspected.
    // Then: clip identity is facility-scoped and event binding is singular.
    expect(schema).toContain('model MediaClip {');
    expect(schema).toContain('model EventMediaBinding {');
    expect(schema).toContain('eventId    String   @id @map("event_id")');
    expect(schema).toContain('@@unique([facilityId, externalClipId])');
    expect(schema).toContain(
      '@relation(fields: [facilityId, eventId], references: [facilityId, id])',
    );
    expect(schema).toContain(
      '@relation(fields: [facilityId, clipId], references: [facilityId, id])',
    );
  });

  it('keeps lifecycle tombstones, retention holds, and access audit durable', () => {
    // Given: lifecycle and access truth must survive process restarts.
    // When: the media models are inspected.
    // Then: terminal reasons, hold release, and bounded audit evidence persist.
    expect(schema).toContain('enum MediaClipStatus {');
    expect(schema).toContain('EXPIRED');
    expect(schema).toContain('DELETED');
    expect(schema).toContain('model MediaRetentionHold {');
    expect(schema).toContain('releasedAt       DateTime?');
    expect(schema).toContain('model MediaAccessLog {');
    expect(schema).toMatch(/ipHash\s+String\?[^\n]*@db\.Char\(64\)/);
    expect(schema).toMatch(/userAgent\s+String\?[^\n]*@db\.VarChar\(512\)/);
    expect(schema).toMatch(/bytesActual\s+BigInt\?/);
  });

  it('refuses ambiguous legacy data and reports identifiers left unbound', () => {
    // Given: legacy clip ids are not relationally constrained.
    // When: the additive backfill runs.
    // Then: cross-camera ambiguity aborts and invalid ids remain unchanged.
    expect(migration).toContain(
      "RAISE EXCEPTION 'legacy clip_id maps to multiple cameras in one facility'",
    );
    expect(migration).toContain(
      "RAISE NOTICE 'legacy clip_id left unbound: % row(s)'",
    );
    expect(migration).toContain(
      "'legacy_' || md5(facility_id || ':' || clip_id)",
    );
    expect(migration).not.toMatch(/UPDATE\s+events\s+SET\s+clip_id/i);
  });

  it('enforces media integrity constraints in PostgreSQL', () => {
    // Given: Prisma cannot express every media invariant.
    // When: the SQL constraints are inspected.
    // Then: state, identity, hash, size, duration, time, and READY are guarded.
    expect(migration).toContain('CHECK (state_version >= 1)');
    expect(migration).toContain(
      "CHECK (external_clip_id ~ '^[A-Za-z0-9._-]{1,200}$')",
    );
    expect(migration).toContain(
      "CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$')",
    );
    expect(migration).toContain('CHECK (byte_size IS NULL OR byte_size > 0)');
    expect(migration).toContain(
      'CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 120000)',
    );
    expect(migration).toContain(
      'CHECK (clip_start_at IS NULL OR clip_end_at IS NULL OR clip_start_at <= clip_end_at)',
    );
    expect(migration).toContain("CHECK (status <> 'READY' OR");
  });

  it('registers every media tenant model in both application and database guards', () => {
    // Given: application context and PostgreSQL RLS are independent fail-closed layers.
    // When: each media tenant table is inspected.
    // Then: all are registered, forced through RLS, and denied without a GUC.
    const registrations = [
      ['MediaClip', 'media_clips'],
      ['EventMediaBinding', 'event_media_bindings'],
      ['MediaRetentionHold', 'media_retention_holds'],
      ['MediaAccessLog', 'media_access_logs'],
    ] as const;

    for (const [model, table] of registrations) {
      expect(prismaService).toContain(`'${model}'`);
      expect(migration).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
      );
      expect(migration).toContain(
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
      );
      expect(migration).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
    }
  });

  it('keeps audit append-only and media deletion tombstone-only for the app role', () => {
    // Given: runtime uses the restricted fall_app role.
    // When: grants from the expand migration are inspected.
    // Then: audit cannot mutate and media rows cannot be physically deleted.
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON media_access_logs TO fall_app;',
    );
    expect(migration).toContain(
      'REVOKE UPDATE, DELETE ON media_access_logs FROM fall_app;',
    );
    expect(migration).toContain(
      'GRANT USAGE, SELECT ON SEQUENCE media_access_logs_id_seq TO fall_app;',
    );
    expect(migration).toContain(
      'REVOKE DELETE ON media_clips, event_media_bindings, media_retention_holds FROM fall_app;',
    );
  });
});
