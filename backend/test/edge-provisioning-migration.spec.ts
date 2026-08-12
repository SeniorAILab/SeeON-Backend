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
const validationLinkMigrationPath = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260810120000_event_validation_grant_link',
  'migration.sql',
);
const validationLinkMigration = existsSync(validationLinkMigrationPath)
  ? readFileSync(validationLinkMigrationPath, 'utf8')
  : '';
// Placement ids are globally keyed, so every fixture owned by this suite uses
// the same prefix as clearFixtures instead of generic cross-suite ids.
const facilityA = 'edge-migration-facility-a';
const facilityB = 'edge-migration-facility-b';
const floorA = 'edge-migration-floor-a';
const floorB = 'edge-migration-floor-b';
const spaceA = 'edge-migration-space-a';
const spaceB = 'edge-migration-space-b';
const cameraA = 'edge-migration-camera-a';
const cameraB = 'edge-migration-camera-b';
const eventA = 'edge-migration-event-a';
const validationEventA = 'edge-migration-validation-event-a';
const clipA = 'edge-migration-clip-a';
const managedUser = 'edge-migration-managed-user';
const generationA = 'edge-migration-generation-a';
const generationB = 'edge-migration-generation-b';
const installationA = '11111111-1111-4111-8111-111111111111';
const installationB = '22222222-2222-4222-8222-222222222222';
const validationRunA = '55555555-5555-4555-8555-555555555555';
const validationRunB = '66666666-6666-4666-8666-666666666666';
const processId = '33333333-3333-4333-8333-333333333333';
const downloadId = '44444444-4444-4444-8444-444444444444';
const completeTransferManifest = [
  {
    kind: 'FLOOR',
    edgeRef: 'floor-1',
    canonicalId: floorA,
    parentCanonicalId: null,
  },
  {
    kind: 'ROOM',
    edgeRef: 'room-1',
    canonicalId: spaceA,
    parentCanonicalId: floorA,
  },
  {
    kind: 'CAMERA',
    edgeRef: 'camera-1',
    canonicalId: cameraA,
    parentCanonicalId: spaceA,
  },
] as const;
const setupStatements = [
  `INSERT INTO facilities (id,name) VALUES ('${facilityA}','A'),('${facilityB}','B')`,
  `INSERT INTO floors (id,facility_id,name,order_index) VALUES ('${floorA}','${facilityA}','1F',1),('${floorB}','${facilityB}','1F',1)`,
  `INSERT INTO spaces (id,facility_id,floor_id,name,type,capacity) VALUES ('${spaceA}','${facilityA}','${floorA}','A','ROOM',1),('${spaceB}','${facilityB}','${floorB}','B','ROOM',1)`,
  `INSERT INTO cameras (id,facility_id,space_id,label) VALUES ('${cameraA}','${facilityA}','${spaceA}','A'),('${cameraB}','${facilityB}','${spaceB}','B')`,
  `INSERT INTO events (id,facility_id,camera_id,space_id,type,detected_at,modified_at,dedup_key) VALUES ('${eventA}','${facilityA}','${cameraA}','${spaceA}','fall',now(),now(),'${eventA}')`,
  `INSERT INTO media_clips (id,facility_id,camera_id,external_clip_id,updated_at) VALUES ('${clipA}','${facilityA}','${cameraA}','${clipA}',now())`,
  `INSERT INTO users (id,nickname) VALUES ('${managedUser}','Managed')`,
  `INSERT INTO edge_installations (id,facility_id,current_generation,updated_at) VALUES ('${installationA}','${facilityA}',1,now()),('${installationB}','${facilityB}',1,now())`,
  `INSERT INTO edge_installation_generations (id,facility_id,edge_installation_id,enrollment_generation,updated_at) VALUES ('${generationA}','${facilityA}','${installationA}',1,now()),('${generationB}','${facilityB}','${installationB}',1,now())`,
] as const;
const cleanupTables = [
  'media_download_outbox_jobs',
  'media_download_audits',
  'edge_provisioning_audit_history',
  'events',
  'edge_validation_grants',
  'edge_omission_previews',
  'edge_topology_snapshots',
  'edge_ownership_transfers',
  'edge_topology_aliases',
  'edge_credentials',
  'media_clips',
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

  it('adds an additive facility-safe validation grant discriminator', () => {
    // Given: validation events need durable ownership without changing historical rows.
    // When: the Prisma model and follow-up migration are inspected.
    // Then: the nullable discriminator has a same-facility FK and supporting index.
    expect(schema).toMatch(
      /validationRunId\s+String\?\s+@map\("validation_run_id"\)\s+@db\.Uuid/,
    );
    expect(schema).toMatch(
      /validationGrant\s+EdgeValidationGrant\?\s+@relation\(fields:\s*\[facilityId,\s*validationRunId\],\s*references:\s*\[facilityId,\s*id\],\s*onDelete:\s*Restrict,\s*onUpdate:\s*Cascade\)/,
    );
    expect(schema).toMatch(/events\s+Event\[\]/);
    expect(schema).toContain('@@unique([facilityId, id])');
    expect(schema).toContain('@@index([facilityId, validationRunId])');
    expect(validationLinkMigration).toContain(
      'ALTER TABLE "events" ADD COLUMN "validation_run_id" UUID;',
    );
    expect(validationLinkMigration).toContain(
      'edge_validation_grants_facility_id_id_key',
    );
    expect(validationLinkMigration).toContain(
      'events_facility_id_validation_run_id_idx',
    );
    expect(validationLinkMigration).toContain(
      'events_facility_id_validation_run_id_fkey',
    );
    expect(validationLinkMigration).not.toMatch(
      /\bDROP\s+(?:TABLE|COLUMN|POLICY)\b/i,
    );
    expect(validationLinkMigration).not.toMatch(/\bREVOKE\b/i);
  });

  it('keeps ordinary events null while validation events resolve only to same-facility grants', async () => {
    // Given: one validation grant per fixture facility and one historical ordinary event.
    await executeAll(direct, [
      `INSERT INTO edge_validation_grants (id,facility_id,edge_installation_id,enrollment_generation,expires_at) VALUES ('${validationRunA}','${facilityA}','${installationA}',1,now()+interval '15 minutes')`,
      `INSERT INTO edge_validation_grants (id,facility_id,edge_installation_id,enrollment_generation,expires_at) VALUES ('${validationRunB}','${facilityB}','${installationB}',1,now()+interval '15 minutes')`,
    ]);

    // When: a post-v1 event links its grant and a cross-facility link is attempted.
    await sql(
      direct,
      `INSERT INTO events (id,facility_id,camera_id,space_id,type,detected_at,modified_at,dedup_key,validation_run_id) VALUES ('${validationEventA}','${facilityA}','${cameraA}','${spaceA}','fall',now(),now(),'${validationEventA}','${validationRunA}')`,
    );
    await expect(
      sql(
        direct,
        `UPDATE events SET validation_run_id='${validationRunB}' WHERE id='${eventA}'`,
      ),
    ).rejects.toThrow();

    // Then: null retains historical semantics and the linked event joins its owning grant.
    const rows = await direct.$queryRaw<
      Array<{
        event_id: string;
        validation_run_id: string | null;
        grant_id: string | null;
      }>
    >`SELECT event_row.id AS event_id,event_row.validation_run_id,grant_row.id AS grant_id
      FROM events event_row
      LEFT JOIN edge_validation_grants grant_row
        ON grant_row.facility_id=event_row.facility_id AND grant_row.id=event_row.validation_run_id
      WHERE event_row.id IN (${eventA},${validationEventA})
      ORDER BY event_row.id`;
    expect(rows).toEqual([
      { event_id: eventA, validation_run_id: null, grant_id: null },
      {
        event_id: validationEventA,
        validation_run_id: validationRunA,
        grant_id: validationRunA,
      },
    ]);
  });

  it('scopes refs and requires an exact manifest for PRODUCT ownership transfer', async () => {
    // Given: the same room ref is valid in two facilities and aliases alone preserve PRODUCT ownership.
    await sql(
      direct,
      aliasSql(
        'edge-migration-alias-room-a',
        facilityA,
        installationA,
        'ROOM',
        'room-1',
        spaceA,
        floorA,
      ),
    );
    await sql(
      direct,
      aliasSql(
        'edge-migration-alias-room-b',
        facilityB,
        installationB,
        'ROOM',
        'room-1',
        spaceB,
        floorB,
      ),
    );
    await sql(
      direct,
      aliasSql(
        'edge-migration-alias-floor-a',
        facilityA,
        installationA,
        'FLOOR',
        'floor-1',
        floorA,
        null,
      ),
    );
    await sql(
      direct,
      aliasSql(
        'edge-migration-alias-camera-a',
        facilityA,
        installationA,
        'CAMERA',
        'camera-1',
        cameraA,
        spaceA,
      ),
    );
    const transferFloor = () =>
      sql(
        direct,
        `UPDATE floors SET provisioning_source='EDGE',edge_installation_id='${installationA}',edge_ref='floor-1' WHERE id='${floorA}'`,
      );

    // When: duplicate/cross-facility claims and an alias-only transfer are attempted.
    await expect(
      sql(
        direct,
        aliasSql(
          'edge-migration-duplicate',
          facilityA,
          installationA,
          'ROOM',
          'room-1',
          spaceA,
          floorA,
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
            'edge-migration-cross',
            facilityA,
            installationA,
            'ROOM',
            'room-cross',
            spaceB,
            floorB,
          ),
        );
      }),
    ).rejects.toThrow();
    await expect(transferFloor()).rejects.toThrow();
    const legacy = await direct.$queryRaw<
      Array<{ event_id: string; clip_id: string }>
    >`SELECT e.id AS event_id,m.id AS clip_id FROM events e JOIN media_clips m ON m.camera_id=e.camera_id WHERE e.id=${eventA}`;
    expect(legacy).toEqual([{ event_id: eventA, clip_id: clipA }]);
    await expect(
      sql(
        direct,
        `INSERT INTO cameras (id,facility_id,space_id,label) VALUES ('edge-migration-camera-a2','${facilityA}','${spaceA}','A2')`,
      ),
    ).rejects.toThrow();
    const transferId = '0197f671-3a31-7a6c-a6e4-83ed412de810';
    await sql(direct, transferSql({ id: transferId, status: 'PENDING' }));
    await direct.$transaction(async (tx) => {
      await executeAll(tx, [
        `UPDATE edge_ownership_transfers SET status='SUCCEEDED',result='{"status":"SUCCEEDED"}'::jsonb,applied_server_revision=1,applied_at=now() WHERE id='${transferId}'`,
        `UPDATE facilities SET topology_revision=1 WHERE id='${facilityA}'`,
        `UPDATE floors SET provisioning_source='EDGE',edge_installation_id='${installationA}',edge_ref='floor-1' WHERE id='${floorA}'`,
      ]);
    });

    // Then: failed transactions leave no audit, and the explicit complete manifest is immutable.
    const audit = await direct.$queryRaw<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM edge_provisioning_audit_history WHERE request_id='rollback'`;
    expect(audit).toEqual([{ count: 0 }]);
    await expect(
      sql(
        direct,
        `UPDATE edge_ownership_transfers SET manifest='[]'::jsonb WHERE id='${transferId}'`,
      ),
    ).rejects.toThrow();
    await expect(
      sql(
        direct,
        `UPDATE edge_ownership_transfers SET result='{"status":"replayed"}'::jsonb WHERE id='${transferId}'`,
      ),
    ).rejects.toThrow();
  });

  it.each([
    ['PENDING', '0197f671-3a31-7a6c-a6e4-83ed412de811'],
    ['FAILED', '0197f671-3a31-7a6c-a6e4-83ed412de812'],
    ['UNKNOWN', '0197f671-3a31-7a6c-a6e4-83ed412de813'],
  ] as const)(
    'rejects %s ownership transfers without topology or audit writes',
    async (status, transferId) => {
      // Given: a complete manifest whose transfer has not reached the applied terminal state.
      await seedFacilityAAliases(direct);
      await sql(direct, transferSql({ id: transferId, status }));

      // When: the transfer attempts to claim PRODUCT topology in one transaction.
      await expect(
        direct.$transaction(async (tx) => {
          await executeAll(tx, [
            `INSERT INTO edge_provisioning_audit_history (facility_id,action,outcome,request_id) VALUES ('${facilityA}','TRANSFER','STARTED','${transferId}')`,
            `UPDATE floors SET provisioning_source='EDGE',edge_installation_id='${installationA}',edge_ref='floor-1' WHERE id='${floorA}'`,
          ]);
        }),
      ).rejects.toThrow();

      // Then: PostgreSQL rolls back the attempted topology and audit writes.
      await expect(transferState(direct, transferId)).resolves.toEqual([
        {
          provisioning_source: 'PRODUCT',
          audit_count: 0,
          result: status === 'PENDING' ? null : { status },
        },
      ]);
    },
  );

  it('rejects an applied transfer from a stale enrollment generation', async () => {
    // Given: a valid applied transfer for generation one after the installation advances to generation two.
    const transferId = '0197f671-3a31-7a6c-a6e4-83ed412de814';
    await seedFacilityAAliases(direct);
    await sql(direct, transferSql({ id: transferId, status: 'SUCCEEDED' }));
    await direct.$transaction(async (tx) => {
      await executeAll(tx, [
        `INSERT INTO edge_installation_generations (id,facility_id,edge_installation_id,enrollment_generation,updated_at) VALUES ('edge-migration-generation-a-2','${facilityA}','${installationA}',2,now())`,
        `UPDATE edge_installations SET current_generation=2 WHERE id='${installationA}'`,
        `UPDATE facilities SET topology_revision=1 WHERE id='${facilityA}'`,
      ]);
    });

    // When: the stale generation attempts to claim PRODUCT topology.
    await expect(transferFloorWithAudit(direct, transferId)).rejects.toThrow();

    // Then: no topology or audit write survives.
    await expect(transferState(direct, transferId)).resolves.toEqual([
      {
        provisioning_source: 'PRODUCT',
        audit_count: 0,
        result: { status: 'SUCCEEDED' },
      },
    ]);
  });

  it('rejects an applied transfer whose revision evidence is stale', async () => {
    // Given: a transfer applied at revision one while the facility is already at revision two.
    const transferId = '0197f671-3a31-7a6c-a6e4-83ed412de815';
    await seedFacilityAAliases(direct);
    await sql(direct, transferSql({ id: transferId, status: 'SUCCEEDED' }));
    await sql(
      direct,
      `UPDATE facilities SET topology_revision=2 WHERE id='${facilityA}'`,
    );

    // When: stale revision evidence attempts to claim PRODUCT topology.
    await expect(transferFloorWithAudit(direct, transferId)).rejects.toThrow();

    // Then: no topology or audit write survives.
    await expect(transferState(direct, transferId)).resolves.toEqual([
      {
        provisioning_source: 'PRODUCT',
        audit_count: 0,
        result: { status: 'SUCCEEDED' },
      },
    ]);
  });

  it('rejects a duplicate manifest entry that hides an omitted persisted alias', async () => {
    // Given: three persisted aliases and a three-item manifest duplicating the floor while omitting the camera.
    const transferId = '0197f671-3a31-7a6c-a6e4-83ed412de816';
    await seedFacilityAAliases(direct);
    const duplicateWithOmission = [
      completeTransferManifest[0],
      completeTransferManifest[0],
      completeTransferManifest[1],
    ];

    // When/Then: multiplicity cannot disguise unequal identity sets.
    await expect(
      sql(
        direct,
        transferSql({
          id: transferId,
          status: 'PENDING',
          manifest: duplicateWithOmission,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      sql(
        direct,
        transferSql({
          id: '0197f671-3a31-7a6c-a6e4-83ed412de817',
          status: 'PENDING',
          manifest: [...completeTransferManifest, completeTransferManifest[0]],
        }),
      ),
    ).rejects.toThrow();
  });

  it('keeps UNKNOWN transfer replay evidence immutable', async () => {
    // Given: an UNKNOWN transfer with a complete persisted alias manifest.
    const transferId = '0197f671-3a31-7a6c-a6e4-83ed412de818';
    await seedFacilityAAliases(direct);
    await sql(direct, transferSql({ id: transferId, status: 'UNKNOWN' }));

    // When/Then: replay cannot rewrite the terminal result or status.
    await expect(
      sql(
        direct,
        `UPDATE edge_ownership_transfers SET status='PENDING',result=NULL WHERE id='${transferId}'`,
      ),
    ).rejects.toThrow();
  });

  it('persists immutable managed identity and recoverable download leases under forced RLS', async () => {
    // Given: a managed identity, process heartbeat, and one facility alias.
    await executeAll(direct, [
      `UPDATE users SET managed_identity_key='senior-ai-lab-primary' WHERE id='${managedUser}'`,
      `INSERT INTO media_download_process_heartbeats (process_id,heartbeat_at,lease_expires_at) VALUES ('${processId}',now(),now()+interval '180 seconds')`,
      aliasSql(
        'edge-migration-rls-room',
        facilityA,
        installationA,
        'ROOM',
        'room-rls',
        spaceA,
        floorA,
      ),
    ]);

    // When: identity mutation and an orphan STARTED audit are attempted.
    await expect(
      sql(
        direct,
        `UPDATE users SET managed_identity_key='changed' WHERE id='${managedUser}'`,
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
type TransferManifestItem = {
  readonly kind: string;
  readonly edgeRef: string;
  readonly canonicalId: string;
  readonly parentCanonicalId: string | null;
};
type TransferFixture = {
  readonly id: string;
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  readonly generation?: number;
  readonly expectedRevision?: number;
  readonly appliedRevision?: number;
  readonly manifest?: readonly TransferManifestItem[];
};
type TransferState = {
  readonly provisioning_source: string;
  readonly audit_count: number;
  readonly result: unknown;
};
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
const transferSql = ({
  id,
  status,
  generation = 1,
  expectedRevision = 0,
  appliedRevision = expectedRevision + 1,
  manifest = completeTransferManifest,
}: TransferFixture): string =>
  `INSERT INTO edge_ownership_transfers (id,facility_id,edge_installation_id,enrollment_generation,expected_server_revision,manifest_digest,manifest,status,result,applied_server_revision,applied_at) VALUES ('${id}','${facilityA}','${installationA}',${generation},${expectedRevision},'${'a'.repeat(64)}','${JSON.stringify(manifest)}','${status}',${status === 'PENDING' ? 'NULL' : `'${JSON.stringify({ status })}'::jsonb`},${status === 'SUCCEEDED' ? appliedRevision : 'NULL'},${status === 'SUCCEEDED' ? 'now()' : 'NULL'})`;
async function seedFacilityAAliases(db: SqlClient): Promise<void> {
  await executeAll(db, [
    aliasSql(
      'edge-migration-transfer-floor-a',
      facilityA,
      installationA,
      'FLOOR',
      'floor-1',
      floorA,
      null,
    ),
    aliasSql(
      'edge-migration-transfer-room-a',
      facilityA,
      installationA,
      'ROOM',
      'room-1',
      spaceA,
      floorA,
    ),
    aliasSql(
      'edge-migration-transfer-camera-a',
      facilityA,
      installationA,
      'CAMERA',
      'camera-1',
      cameraA,
      spaceA,
    ),
  ]);
}
const transferFloorWithAudit = (
  db: PrismaClient,
  transferId: string,
): Promise<unknown> =>
  db.$transaction(async (tx) => {
    await executeAll(tx, [
      `INSERT INTO edge_provisioning_audit_history (facility_id,action,outcome,request_id) VALUES ('${facilityA}','TRANSFER','STARTED','${transferId}')`,
      `UPDATE floors SET provisioning_source='EDGE',edge_installation_id='${installationA}',edge_ref='floor-1' WHERE id='${floorA}'`,
    ]);
  });
const transferState = (
  db: PrismaClient,
  transferId: string,
): Promise<TransferState[]> =>
  db.$queryRawUnsafe<TransferState[]>(
    `SELECT floor.provisioning_source::text, count(audit.id)::int AS audit_count, transfer.result
     FROM floors floor
     JOIN edge_ownership_transfers transfer ON transfer.id=$1::uuid
     LEFT JOIN edge_provisioning_audit_history audit ON audit.request_id=$1
     WHERE floor.id='${floorA}'
     GROUP BY floor.provisioning_source,transfer.result`,
    transferId,
  );
const downloadSql = (): string =>
  `INSERT INTO media_download_audits (id,facility_id,clip_id,alert_id,actor_user_id,actor_role,request_id,http_status,process_id,lease_version,stream_lease_expires_at,updated_at) VALUES ('${downloadId}','${facilityA}','${clipA}','edge-migration-alert-a','${managedUser}','ADMIN','request',200,'${processId}',1,now()+interval '120 seconds',now())`;

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
      `DELETE FROM users WHERE id='${managedUser}'`,
      `DELETE FROM facilities WHERE id LIKE 'edge-migration-%'`,
    ]);
  });
}
