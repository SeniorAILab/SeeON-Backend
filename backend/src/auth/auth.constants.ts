import { Role } from '@prisma/client';

export const SESSION_COOKIE_NAME = 'app_session';
/**
 * 세션 수명. 쿠키 max-age도 auth.service의 jwtTtlSeconds()로 여기서 파생된다.
 *
 * 요양보호사가 TV에 화면을 상시 띄워두고 그 화면으로 낙상 알림을 받는다.
 * refresh 경로가 없으므로 TTL이 만료되면 TV가 조용히 로그인 화면으로 튕기고
 * 아무도 눈치채지 못한다. 12h였을 때는 아침에 켠 TV가 저녁에 죽었다 —
 * 낙상이 제일 많은 야간이 그대로 사각지대였다.
 */
export const DEFAULT_JWT_TTL = '30d';

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
