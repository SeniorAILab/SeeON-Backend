import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    __dirname,
    '../../prisma/migrations/20260717030000_dashboard_receipt_history/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(
  join(__dirname, '../../prisma/schema.prisma'),
  'utf8',
);
const prismaService = readFileSync(
  join(__dirname, 'prisma.service.ts'),
  'utf8',
);

describe('dashboard receipt migration', () => {
  it('keeps receipt identity tenant scoped and idempotent per client surface', () => {
    expect(schema).toContain('model DashboardReceipt {');
    expect(schema).toContain(
      '@@unique([facilityId, dashboardClientId, kind, alertId, alertSeq, surface]',
    );
    expect(migration).toContain(
      '"dashboard_receipt_history_client_kind_alert_seq_surface_key"',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("facility_id", "backend_event_id") REFERENCES "events"("facility_id", "id")',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("facility_id", "alert_id") REFERENCES "alerts"("facility_id", "id")',
    );
  });

  it('forces tenant RLS and permits append-only runtime access', () => {
    expect(prismaService).toContain("'DashboardReceipt'");
    expect(migration).toContain(
      'ALTER TABLE "dashboard_receipt_history" ENABLE ROW LEVEL SECURITY;',
    );
    expect(migration).toContain(
      'ALTER TABLE "dashboard_receipt_history" FORCE ROW LEVEL SECURITY;',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON "dashboard_receipt_history" TO fall_app;',
    );
    expect(migration).toContain(
      'REVOKE UPDATE, DELETE ON "dashboard_receipt_history" FROM fall_app;',
    );
  });
});
