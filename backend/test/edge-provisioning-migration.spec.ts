import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

// allow: SIZE_OK — one focused migration spec keeps atomic SQL/RLS evidence in the task-owned file.

const migrationPath = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260810060000_edge_enrollment_topology_persistence',
  'migration.sql',
);
const schema = readFileSync(
  join(__dirname, '..', 'prisma', 'schema.prisma'),
  'utf8',
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8')
  : '';
const facilityA = 'edge-migration-facility-a';
const facilityB = 'edge-migration-facility-b';
const installationA = '11111111-1111-4111-8111-111111111111';
const installationB = '22222222-2222-4222-8222-222222222222';
const processId = '33333333-3333-4333-8333-333333333333';
const downloadId = '44444444-4444-4444-8444-444444444444';
const setupStatements = [
  `INSERT INTO facilities (id,name) VALUES ('${facilityA}','A'),('${facilityB}','B')`,
  `INSERT INTO floors (id,facility_id,name,order_index) VALUES ('floor-a','${facilityA}','1F',1),('floor-b','${facilityB}','1F',1)`,
  `INSERT INTO spaces (id,facility_id,floor_id,name,type,capacity) VALUES ('space-a','${facilityA}','floor-a','A','ROOM',1),('space-b','${facilityB}','floor-b','B','ROOM',1)`,
  `INSERT INTO cameras (id,facility_id,space_id,label) VALUES ('camera-a','${facilityA}','space-a','A'),('camera-b','${facilityB}','space-b','B')`,
  `INSERT INTO events (id,facility_id,camera_id,space_id,type,detected_at,modified_at,dedup_key) VALUES ('event-a','${facilityA}','camera-a','space-a','fall',now(),now(),'event-a')`,
  `INSERT INTO media_clips (id,facility_id,camera_id,external_clip_id,updated_at) VALUES ('clip-a','${facilityA}','camera-a','clip-a',now())`,
  `INSERT INTO users (id,nickname) VALUES ('managed-user','Managed')`,
  `INSERT INTO edge_installations (id,facility_id,current_generation,updated_at) VALUES ('${installationA}','${facilityA}',1,now()),('${installationB}','${facilityB}',1,now())`,
  `INSERT INTO edge_installation_generations (id,facility_id,edge_installation_id,enrollment_generation,updated_at) VALUES ('generation-a','${facilityA}','${installationA}',1,now()),('generation-b','${facilityB}','${installationB}',1,now())`,
] as const;
const cleanupTables = [
  'media_download_outbox_jobs',
  'media_download_audits',
  'edge_provisioning_audit_history',
  'edge_validation_grants',
  'edge_omission_previews',
  'edge_topology_snapshots',
  'edge_ownership_transfers',
  'edge_topology_aliases',
  'edge_credentials',
  'media_clips',
  'events',
  'cameras',
  'spaces',
  'floors',
] as const;

describe('edge provisioning persistence migration', () => {
  let direct: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DIRECT_URL || !process.env.DATABASE_URL)
      throw new Error('DIRECT_URL and DATABASE_URL are required');
    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    await direct.$connect();
  });

  beforeEach(async () => {
    await clearFixtures(direct);
    await direct.$transaction(async (tx) => executeAll(tx, setupStatements));
  });

  afterAll(async () => {
    await clearFixtures(direct);
    await direct.$disconnect();
  });

  it('adds every frozen aggregate and guard without destructive SQL', () => {
    // Given: the frozen persistence contract and one additive migration.
    const models =
      'EdgeInstallation EdgeInstallationGeneration EdgeCredential EdgeAdminOperation EdgeTopologySnapshot EdgeOmissionPreview EdgeTopologyAlias EdgeOwnershipTransfer EdgeValidationGrant EdgeProvisioningAudit MediaDownloadAudit MediaDownloadProcessHeartbeat MediaDownloadOutboxJob'.split(
        ' ',
      );
    const fields =
      'managedIdentityKey acceptedClientRevision canonicalBody omittedFloorRefs manifestDigest leaseVersion streamLeaseExpiresAt recoveryStartedAt recoveredAt'.split(
        ' ',
      );
    const tenantTables =
      'edge_topology_snapshots edge_omission_previews edge_topology_aliases edge_ownership_transfers edge_validation_grants edge_provisioning_audit_history media_download_audits media_download_outbox_jobs'.split(
        ' ',
      );

    // When: Prisma and PostgreSQL contracts are inspected.
    // Then: persistence, immutability, ownership, outbox, RLS, and compatibility are complete.
    for (const model of models) expect(schema).toContain(`model ${model} {`);
    for (const field of fields) expect(schema).toContain(field);
    for (const table of tenantTables) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
      );
      expect(migration).toContain(
        `CREATE POLICY tenant_isolation ON "${table}"`,
      );
    }
    expect(migration).not.toEqual('');
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
    expect(migration).toContain('users_managed_identity_key_immutable');
    expect(migration).toContain(
      'PRODUCT ownership requires an explicit transfer manifest',
    );
    expect(migration).toContain('media_download_audit_requires_outbox');
  });

  it('scopes refs and requires an exact manifest for PRODUCT ownership transfer', async () => {
    // Given: the same room ref is valid in two facilities and aliases alone preserve PRODUCT ownership.
    await sql(
      direct,
      aliasSql(
        'alias-room-a',
        facilityA,
        installationA,
        'ROOM',
        'room-1',
        'space-a',
        'floor-a',
      ),
    );
    await sql(
      direct,
      aliasSql(
        'alias-room-b',
        facilityB,
        installationB,
        'ROOM',
        'room-1',
        'space-b',
        'floor-b',
      ),
    );
    await sql(
      direct,
      aliasSql(
        'alias-floor-a',
        facilityA,
        installationA,
        'FLOOR',
        'floor-1',
        'floor-a',
        null,
      ),
    );
    await sql(
      direct,
      aliasSql(
        'alias-camera-a',
        facilityA,
        installationA,
        'CAMERA',
        'camera-1',
        'camera-a',
        'space-a',
      ),
    );
    const transferFloor = () =>
      sql(
        direct,
        `UPDATE floors SET provisioning_source='EDGE',edge_installation_id='${installationA}',edge_ref='floor-1' WHERE id='floor-a'`,
      );

    // When: duplicate/cross-facility claims and an alias-only transfer are attempted.
    await expect(
      sql(
        direct,
        aliasSql(
          'duplicate',
          facilityA,
          installationA,
          'ROOM',
          'room-1',
          'space-a',
          'floor-a',
        ),
      ),
    ).rejects.toThrow();
    await expect(
      direct.$transaction(async (tx) => {
        await sql(
          tx,
          `INSERT INTO edge_provisioning_audit_history (facility_id,action,outcome,request_id) VALUES ('${facilityA}','ALIAS','STARTED','rollback')`,
        );
        await sql(
          tx,
          aliasSql(
            'cross',
            facilityA,
            installationA,
            'ROOM',
            'room-cross',
            'space-b',
            'floor-b',
          ),
        );
      }),
    ).rejects.toThrow();
    await expect(transferFloor()).rejects.toThrow();
    const legacy = await direct.$queryRaw<
      Array<{ event_id: string; clip_id: string }>
    >`SELECT e.id AS event_id,m.id AS clip_id FROM events e JOIN media_clips m ON m.camera_id=e.camera_id WHERE e.id='event-a'`;
    expect(legacy).toEqual([{ event_id: 'event-a', clip_id: 'clip-a' }]);
    await expect(
      sql(
        direct,
        `INSERT INTO cameras (id,facility_id,space_id,label) VALUES ('camera-a2','${facilityA}','space-a','A2')`,
      ),
    ).rejects.toThrow();
    await sql(direct, transferSql());
    await transferFloor();

    // Then: failed transactions leave no audit, and the explicit complete manifest is immutable.
    const audit = await direct.$queryRaw<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM edge_provisioning_audit_history WHERE request_id='rollback'`;
    expect(audit).toEqual([{ count: 0 }]);
    await expect(
      sql(
        direct,
        `UPDATE edge_ownership_transfers SET manifest='[]'::jsonb WHERE id='0197f671-3a31-7a6c-a6e4-83ed412de810'`,
      ),
    ).rejects.toThrow();
  });

  it('persists immutable managed identity and recoverable download leases under forced RLS', async () => {
    // Given: a managed identity, process heartbeat, and one facility alias.
    await executeAll(direct, [
      `UPDATE users SET managed_identity_key='senior-ai-lab-primary' WHERE id='managed-user'`,
      `INSERT INTO media_download_process_heartbeats (process_id,heartbeat_at,lease_expires_at) VALUES ('${processId}',now(),now()+interval '180 seconds')`,
      aliasSql(
        'rls-room',
        facilityA,
        installationA,
        'ROOM',
        'room-rls',
        'space-a',
        'floor-a',
      ),
    ]);

    // When: identity mutation and an orphan STARTED audit are attempted.
    await expect(
      sql(
        direct,
        `UPDATE users SET managed_identity_key='changed' WHERE id='managed-user'`,
      ),
    ).rejects.toThrow();
    await expect(sql(direct, downloadSql())).rejects.toThrow();
    await direct.$transaction(async (tx) => {
      await sql(tx, downloadSql());
      await sql(
        tx,
        `INSERT INTO media_download_outbox_jobs (audit_id,facility_id,lease_version,updated_at) VALUES ('${downloadId}','${facilityA}',1,now())`,
      );
    });
    // Then: the job carries recovery state and every tenant table remains forced through RLS.
    const state = await direct.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT a.state::text,a.lease_version,a.stream_lease_expires_at,j.state::text AS job_state,j.recovery_started_at,j.recovered_at,p.lease_expires_at AS process_lease_expires_at FROM media_download_audits a JOIN media_download_outbox_jobs j ON j.audit_id=a.id JOIN media_download_process_heartbeats p ON p.process_id=a.process_id WHERE a.id=${downloadId}::uuid`;
    expect(state[0]).toMatchObject({
      state: 'STARTED',
      lease_version: 1,
      job_state: 'PENDING',
    });
    const forced = await direct.$queryRaw<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM pg_class WHERE relname=ANY(ARRAY['edge_topology_snapshots','edge_omission_previews','edge_topology_aliases','edge_ownership_transfers','edge_validation_grants','edge_provisioning_audit_history','media_download_audits','media_download_outbox_jobs']) AND relrowsecurity AND relforcerowsecurity`;
    expect(forced).toEqual([{ count: 8 }]);
  });
});

type SqlClient = Pick<PrismaClient, '$executeRawUnsafe'>;
const sql = (db: SqlClient, statement: string): Promise<number> =>
  db.$executeRawUnsafe(statement);
async function executeAll(
  db: SqlClient,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) await sql(db, statement);
}
const aliasSql = (
  id: string,
  facility: string,
  installation: string,
  kind: string,
  edgeRef: string,
  canonical: string,
  parent: string | null,
): string =>
  `INSERT INTO edge_topology_aliases (id,facility_id,edge_installation_id,enrollment_generation,kind,edge_ref,canonical_id,parent_canonical_id) VALUES ('${id}','${facility}','${installation}',1,'${kind}','${edgeRef}','${canonical}',${parent === null ? 'NULL' : `'${parent}'`})`;
const transferSql = (): string =>
  `INSERT INTO edge_ownership_transfers (id,facility_id,edge_installation_id,enrollment_generation,expected_server_revision,manifest_digest,manifest) VALUES ('0197f671-3a31-7a6c-a6e4-83ed412de810','${facilityA}','${installationA}',1,0,'${'a'.repeat(64)}','[{"kind":"FLOOR","edgeRef":"floor-1","canonicalId":"floor-a","parentCanonicalId":null},{"kind":"ROOM","edgeRef":"room-1","canonicalId":"space-a","parentCanonicalId":"floor-a"},{"kind":"CAMERA","edgeRef":"camera-1","canonicalId":"camera-a","parentCanonicalId":"space-a"}]')`;
const downloadSql = (): string =>
  `INSERT INTO media_download_audits (id,facility_id,clip_id,alert_id,actor_user_id,actor_role,request_id,http_status,process_id,lease_version,stream_lease_expires_at,updated_at) VALUES ('${downloadId}','${facilityA}','clip-a','alert-a','managed-user','ADMIN','request',200,'${processId}',1,now()+interval '120 seconds',now())`;

async function clearFixtures(db: PrismaClient): Promise<void> {
  await db.$transaction(async (tx) => {
    for (const table of cleanupTables)
      await sql(
        tx,
        `DELETE FROM ${table} WHERE facility_id LIKE 'edge-migration-%'`,
      );
    await executeAll(tx, [
      `DELETE FROM media_download_process_heartbeats WHERE process_id='${processId}'`,
      `DELETE FROM edge_installations WHERE facility_id LIKE 'edge-migration-%'`,
      `DELETE FROM users WHERE id='managed-user'`,
      `DELETE FROM facilities WHERE id LIKE 'edge-migration-%'`,
    ]);
  });
}
