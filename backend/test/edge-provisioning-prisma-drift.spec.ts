import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const backendRoot = join(__dirname, '..');
const migration = readFileSync(
  join(
    backendRoot,
    'prisma',
    'migrations',
    '20260810060000_edge_enrollment_topology_persistence',
    'migration.sql',
  ),
  'utf8',
);

describe('edge provisioning Prisma migration drift', () => {
  it('models the deferred current-generation foreign key in generated schema SQL', () => {
    // Given: the committed schema and the already-applied deferred migration constraint.
    const environment = {
      ...process.env,
      DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
      DIRECT_URL: 'postgresql://unused:unused@localhost:5432/unused',
    };

    // When: Prisma renders the database contract represented by schema.prisma.
    const generatedSql = execFileSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-empty',
        '--to-schema-datamodel',
        './prisma/schema.prisma',
        '--script',
      ],
      { cwd: backendRoot, env: environment, encoding: 'utf8' },
    );

    // Then: Prisma preserves the FK identity while migration SQL retains deferrability.
    expect(generatedSql).toContain(
      'CONSTRAINT "edge_installations_current_generation_fkey" FOREIGN KEY ("facility_id", "id", "current_generation") REFERENCES "edge_installation_generations"("facility_id", "edge_installation_id", "enrollment_generation") ON DELETE NO ACTION ON UPDATE NO ACTION',
    );
    expect(migration).toMatch(
      /CONSTRAINT "edge_installations_current_generation_fkey"[\s\S]*FOREIGN KEY \("facility_id", "id", "current_generation"\)[\s\S]*REFERENCES "edge_installation_generations"\("facility_id", "edge_installation_id", "enrollment_generation"\)[\s\S]*DEFERRABLE INITIALLY DEFERRED;/,
    );
  });
});
