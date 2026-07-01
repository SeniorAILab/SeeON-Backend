export const SESSION_COOKIE_NAME = 'app_session';
export const OAUTH_STATE_COOKIE_NAME = 'kakao_oauth_state';
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 60;
export const DEFAULT_REFRESH_WINDOW_SECONDS = 10 * 60;
export const OAUTH_STATE_TTL_SECONDS = 5 * 60;

export const AUTH_ROLES = ['SUPER_ADMIN', 'ADMIN', 'STAFF'] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

export type RbacCapability =
  | 'personalLogin'
  | 'facilityOnboarding'
  | 'facilityAdmin'
  | 'monitorView';

export const RBAC_PERMISSIONS: Record<AuthRole, ReadonlySet<RbacCapability>> = {
  SUPER_ADMIN: new Set<RbacCapability>([
    'personalLogin',
    'facilityOnboarding',
    'facilityAdmin',
    'monitorView',
  ]),
  ADMIN: new Set<RbacCapability>([
    'personalLogin',
    'facilityOnboarding',
    'facilityAdmin',
    'monitorView',
  ]),
  STAFF: new Set<RbacCapability>(['personalLogin', 'monitorView']),
};

export const POST_LOGIN_PATHS: Record<AuthRole, string> = {
  SUPER_ADMIN: '/admin/dashboard',
  ADMIN: '/admin/dashboard',
  STAFF: '/now',
};

export function hasRbacCapability(
  role: AuthRole,
  capability: RbacCapability,
): boolean {
  return RBAC_PERMISSIONS[role].has(capability);
}

export function postLoginPathForRole(role: AuthRole): string {
  return POST_LOGIN_PATHS[role];
}

export function isAuthRole(role: string): role is AuthRole {
  switch (role) {
    case 'SUPER_ADMIN':
    case 'ADMIN':
    case 'STAFF':
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
