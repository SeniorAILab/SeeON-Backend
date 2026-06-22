export const SESSION_COOKIE_NAME = 'app_session';
export const OAUTH_STATE_COOKIE_NAME = 'kakao_oauth_state';
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 60;
export const DEFAULT_REFRESH_WINDOW_SECONDS = 10 * 60;
export const OAUTH_STATE_TTL_SECONDS = 5 * 60;

export const BACKEND_ROLES = ['SUPER_ADMIN', 'ADMIN', 'CAREGIVER'] as const;
export type BackendRole = (typeof BACKEND_ROLES)[number];

export type RbacCapability =
  | 'personalLogin'
  | 'facilityOnboarding'
  | 'facilityAdmin'
  | 'monitorView';

export const RBAC_PERMISSIONS: Record<
  BackendRole,
  ReadonlySet<RbacCapability>
> = {
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
  CAREGIVER: new Set<RbacCapability>(['monitorView']),
};

export function hasRbacCapability(
  role: BackendRole,
  capability: RbacCapability,
): boolean {
  return RBAC_PERMISSIONS[role].has(capability);
}

export function assertKnownBackendRole(
  role: string,
): asserts role is BackendRole {
  if (!BACKEND_ROLES.includes(role as BackendRole)) {
    throw new Error(`Unknown backend role: ${role}`);
  }
}
