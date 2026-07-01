import { Role } from '@prisma/client';

export const SESSION_COOKIE_NAME = 'app_session';
export const OAUTH_STATE_COOKIE_NAME = 'kakao_oauth_state';
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 60;
export const DEFAULT_REFRESH_WINDOW_SECONDS = 10 * 60;
export const OAUTH_STATE_TTL_SECONDS = 5 * 60;

export type AuthRole = Role;

export type RbacCapability =
  | 'personalLogin'
  | 'facilityOnboarding'
  | 'facilityAdmin'
  | 'monitorView';

export const RBAC_PERMISSIONS: Record<Role, ReadonlySet<RbacCapability>> = {
  [Role.SUPER_ADMIN]: new Set<RbacCapability>([
    'personalLogin',
    'facilityOnboarding',
    'facilityAdmin',
    'monitorView',
  ]),
  [Role.ADMIN]: new Set<RbacCapability>([
    'personalLogin',
    'facilityOnboarding',
    'facilityAdmin',
    'monitorView',
  ]),
  [Role.STAFF]: new Set<RbacCapability>(['personalLogin', 'monitorView']),
};

export function hasRbacCapability(
  role: AuthRole,
  capability: RbacCapability,
): boolean {
  return RBAC_PERMISSIONS[role].has(capability);
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function postLoginPathForUser(user: {
  role: AuthRole;
  facilityId: string | null;
}): string {
  switch (user.role) {
    case Role.SUPER_ADMIN:
      return '/dashboard';
    case Role.ADMIN:
      return user.facilityId
        ? `/dashboard/facilities/${pathSegment(user.facilityId)}/admin`
        : '/onboarding';
    case Role.STAFF:
      return user.facilityId
        ? `/dashboard/facilities/${pathSegment(user.facilityId)}/staff`
        : '/onboarding';
  }
}

export function isAuthRole(role: string): role is AuthRole {
  switch (role) {
    case Role.SUPER_ADMIN:
    case Role.ADMIN:
    case Role.STAFF:
      return true;
    default:
      return false;
  }
}

export function assertKnownAuthRole(role: string): asserts role is AuthRole {
  if (!isAuthRole(role)) {
    throw new Error(`Unknown auth role: ${role}`);
  }
}
