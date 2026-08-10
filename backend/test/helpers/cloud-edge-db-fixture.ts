import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../../src/auth/password.js';

export const FACILITY_ID = 'a5ff4ed1-7e63-4a4f-9ef0-42e807d74a64';
export const OTHER_FACILITY_ID = 'b5ff4ed1-7e63-4a4f-9ef0-42e807d74a64';
export const SUPER_EMAIL = 'task15-super@example.invalid';
export const ADMIN_EMAIL = 'task15-admin@example.invalid';
export const OTHER_ADMIN_EMAIL = 'task15-other@example.invalid';
export const PASSWORD = 'task15-local-password';

export class CloudEdgeDbFixture {
  readonly direct = new PrismaClient({ datasourceUrl: required('DIRECT_URL') });

  async start(): Promise<void> {
    await this.direct.$connect();
    await this.cleanup();
    const passwordHash = await hashPassword(PASSWORD);
    await this.direct.facility.createMany({
      data: [
        { id: FACILITY_ID, name: 'Task 15 Facility' },
        { id: OTHER_FACILITY_ID, name: 'Task 15 Other Facility' },
      ],
    });
    await this.direct.user.createMany({
      data: [
        {
          email: SUPER_EMAIL,
          nickname: 'Task 15 Super',
          passwordHash,
          role: 'SUPER_ADMIN',
        },
        {
          email: ADMIN_EMAIL,
          facilityId: FACILITY_ID,
          nickname: 'Task 15 Admin',
          passwordHash,
          role: 'ADMIN',
        },
        {
          email: OTHER_ADMIN_EMAIL,
          facilityId: OTHER_FACILITY_ID,
          nickname: 'Task 15 Other Admin',
          passwordHash,
          role: 'ADMIN',
        },
      ],
    });
  }

  disconnect(): Promise<void> {
    return this.direct.$disconnect();
  }

  async cleanup(): Promise<void> {
    const ids = [FACILITY_ID, OTHER_FACILITY_ID];
    await this.direct.mediaDownloadOutboxJob.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.mediaDownloadAudit.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.eventMediaBinding.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.mediaClip.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.alert.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.event.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.mlFacilityConfig.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.edgeProvisioningAudit.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.edgeOmissionPreview.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.edgeTopologySnapshot.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.edgeTopologyAlias.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.edgeCredential.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.edgeAdminOperation.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.camera.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.space.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.floor.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.edgeInstallation.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.user.deleteMany({
      where: { email: { in: [SUPER_EMAIL, ADMIN_EMAIL, OTHER_ADMIN_EMAIL] } },
    });
    await this.direct.facility.deleteMany({ where: { id: { in: ids } } });
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}
