import { Role } from '@prisma/client';
import {
  RBAC_PERMISSIONS,
  hasRbacCapability,
  isAuthRole,
  postLoginPathForUser,
} from './auth.constants';

describe('RBAC SSOT', () => {
  it('defines the exact three backend roles and capability matrix', () => {
    expect(isAuthRole(Role.SUPER_ADMIN)).toBe(true);
    expect(isAuthRole(Role.ADMIN)).toBe(true);
    expect(isAuthRole(Role.STAFF)).toBe(true);
    expect(hasRbacCapability(Role.SUPER_ADMIN, 'personalLogin')).toBe(true);
    expect(hasRbacCapability(Role.ADMIN, 'personalLogin')).toBe(true);
    expect(hasRbacCapability(Role.STAFF, 'personalLogin')).toBe(true);
    expect(hasRbacCapability(Role.STAFF, 'monitorView')).toBe(true);
    expect(hasRbacCapability(Role.ADMIN, 'facilityAdmin')).toBe(true);
    expect(hasRbacCapability(Role.SUPER_ADMIN, 'facilityAdmin')).toBe(true);
    expect(RBAC_PERMISSIONS[Role.STAFF].has('facilityAdmin')).toBe(false);
    expect(
      postLoginPathForUser({ role: Role.SUPER_ADMIN, facilityId: null }),
    ).toBe('/dashboard');
    expect(
      postLoginPathForUser({ role: Role.ADMIN, facilityId: 'fac 1' }),
    ).toBe('/dashboard/facilities/fac%201/admin');
    expect(
      postLoginPathForUser({ role: Role.STAFF, facilityId: 'fac-1' }),
    ).toBe('/dashboard/facilities/fac-1/staff');
  });
});
