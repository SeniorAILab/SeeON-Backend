import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('role_rbac_three_tier migration', () => {
  const previousStaffRole = 'CARE' + 'GIVER';
  const sql = readFileSync(
    join(
      __dirname,
      '../../prisma/migrations/20260622120000_role_rbac_three_tier/migration.sql',
    ),
    'utf8',
  );

  it('rebuilds the Postgres enum and maps legacy OWNER users to ADMIN', () => {
    expect(sql).toContain('ALTER TYPE "Role" RENAME TO "Role_old"');
    expect(sql).toContain(
      `CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', '${previousStaffRole}')`,
    );
    expect(sql).toContain("WHEN 'OWNER' THEN 'ADMIN'");
    expect(sql).toContain(
      "ALTER TABLE users ALTER COLUMN role SET DEFAULT 'ADMIN'",
    );
  });

  it('forces old role-bearing JWT cookies to re-login', () => {
    expect(sql).toContain('SET session_version = session_version + 1');
  });
});

describe('staff role rename migration', () => {
  const previousStaffRole = 'CARE' + 'GIVER';
  const sql = readFileSync(
    join(
      __dirname,
      '../../prisma/migrations/20260701000000_rename_staff_role/migration.sql',
    ),
    'utf8',
  );
  const schema = readFileSync(
    join(__dirname, '../../prisma/schema.prisma'),
    'utf8',
  );

  it('renames the staff role enum value and default', () => {
    expect(sql).toContain(
      `ALTER TYPE "Role" RENAME VALUE '${previousStaffRole}' TO 'STAFF'`,
    );
    expect(sql).toContain(
      "ALTER TABLE users ALTER COLUMN role SET DEFAULT 'STAFF'",
    );
    expect(schema).toContain('role               Role     @default(STAFF)');
  });
});
