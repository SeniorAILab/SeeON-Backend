import * as fs from 'fs';
import * as path from 'path';

const sql = fs.readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20260622150000_alert_space_expand/migration.sql',
  ),
  'utf8',
);

describe('Alert.spaceId migration', () => {
  it('adds nullable Alert.spaceId with composite FK and dashboard index', () => {
    expect(sql).toContain('ALTER TABLE alerts ADD COLUMN space_id TEXT');
    expect(sql).toContain('FOREIGN KEY (facility_id, space_id)');
    expect(sql).toContain('REFERENCES spaces(facility_id, id)');
    expect(sql).toContain(
      'CREATE INDEX alerts_facility_id_space_id_alert_seq_idx ON alerts(facility_id, space_id, alert_seq)',
    );
  });

  it('backfills verified camera mapping before temporal assignment evidence', () => {
    expect(sql).toContain('WITH camera_backfill AS');
    expect(sql).toContain('JOIN cameras c');
    expect(sql).toContain('c.id = a.camera_id');
    expect(sql.indexOf('WITH camera_backfill AS')).toBeLessThan(
      sql.indexOf('WITH assignment_candidates AS'),
    );
  });

  it('uses detected_at covering resident assignments and forbids current-active fallback', () => {
    expect(sql).toContain('ra.started_at <= a.detected_at');
    expect(sql).toContain(
      '(ra.ended_at > a.detected_at OR ra.ended_at IS NULL)',
    );
    expect(sql).toContain('covering_count = 1');
    expect(sql).toContain('Current-active assignment fallback is forbidden');
    expect(sql).not.toContain('ORDER BY ra.started_at DESC');
  });

  it('historical resident-move fixture keeps alerts anchored to detected_at room', () => {
    const assignments = [
      {
        spaceId: 'room-101',
        startedAt: new Date('2026-01-01'),
        endedAt: new Date('2026-02-01'),
      },
      {
        spaceId: 'room-202',
        startedAt: new Date('2026-02-01'),
        endedAt: null,
      },
    ];

    expect(
      backfillFromUniqueCoveringAssignment(assignments, new Date('2026-01-15')),
    ).toBe('room-101');
    expect(
      backfillFromUniqueCoveringAssignment(assignments, new Date('2026-02-15')),
    ).toBe('room-202');
  });

  it('blocks missing and multiple temporal assignment evidence', () => {
    expect(
      backfillFromUniqueCoveringAssignment([], new Date('2026-01-15')),
    ).toBeNull();
    expect(
      backfillFromUniqueCoveringAssignment(
        [
          {
            spaceId: 'room-101',
            startedAt: new Date('2026-01-01'),
            endedAt: null,
          },
          {
            spaceId: 'room-202',
            startedAt: new Date('2026-01-10'),
            endedAt: null,
          },
        ],
        new Date('2026-01-15'),
      ),
    ).toBeNull();
  });

  it('blocks unresolved and ambiguous rows with remediation counts', () => {
    expect(sql).toContain('missing_assignment_count');
    expect(sql).toContain('multiple_assignment_count');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('alert_space_expand blocked');
  });

  it('preserves RLS and fall_app grants for alerts', () => {
    expect(sql).toContain('ALTER TABLE alerts ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE alerts FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON alerts TO fall_app',
    );
  });
});

type AssignmentFixture = {
  spaceId: string;
  startedAt: Date;
  endedAt: Date | null;
};

function backfillFromUniqueCoveringAssignment(
  assignments: AssignmentFixture[],
  detectedAt: Date,
): string | null {
  const covering = assignments.filter(
    (a) =>
      a.startedAt <= detectedAt &&
      (a.endedAt === null || a.endedAt > detectedAt),
  );
  return covering.length === 1 ? covering[0].spaceId : null;
}
