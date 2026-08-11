import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/**
 * Shared support for the legacy shared-edge-token compatibility path used by
 * EdgeFacilityTokenGuard (cameras) and EdgeIngestTokenGuard (events). Both
 * guards accept eft_v1.* per-installation credentials unconditionally; this
 * module governs only the deprecated fallback that authenticates with a
 * single static secret (EDGE_FACILITY_TOKEN) shared by every Edge box.
 *
 * The fallback is fail-closed by default: EDGE_LEGACY_COMPAT_ENABLED must be
 * the exact string 'true' to activate it. Any other value — unset, empty,
 * 'false', a typo, differing case — leaves it disabled. This is a deliberate
 * inversion of the previous "!== 'false'" logic, which left the shared
 * secret authoritative for cross-tenant writes unless someone remembered to
 * set the flag to the literal string 'false'.
 *
 * Once the fallback is enabled, the facility it authorizes must still never
 * come from a client-supplied header (x-facility-id): a holder of the one
 * static secret could otherwise pick any facility it likes. Instead the
 * facility is pinned server-side via EDGE_LEGACY_FACILITY_ID — set only for
 * the duration of a single Edge's migration to eft_v1 credentials — and the
 * legacy path fails closed (ServiceUnavailableException, thrown by callers)
 * when that pin is not configured.
 */
const LEGACY_COMPAT_OPT_IN_VALUE = 'true';

const logger = new Logger('EdgeLegacyCompat');

export function configString(
  config: ConfigService,
  key: string,
): string | null {
  const value = config.get<string>(key);
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim();
}

export function isEdgeLegacyCompatEnabled(config: ConfigService): boolean {
  return (
    configString(config, 'EDGE_LEGACY_COMPAT_ENABLED') ===
    LEGACY_COMPAT_OPT_IN_VALUE
  );
}

/**
 * Server-side-only facility pin for the legacy shared-token path. Returns
 * null when unset, meaning the legacy path cannot establish a facility
 * scope and callers must fail closed rather than fall back to any
 * client-supplied value (in particular, never the x-facility-id header).
 */
export function resolveEdgeLegacyFacilityId(
  config: ConfigService,
): string | null {
  return configString(config, 'EDGE_LEGACY_FACILITY_ID');
}

/**
 * Logs that the deprecated shared-token path was actually used to accept a
 * request, so production logs can confirm when every Edge has migrated to
 * eft_v1 credentials and EDGE_LEGACY_COMPAT_ENABLED can be turned off. Must
 * never receive or log the token itself, any derivation of it (prefix,
 * suffix, hash), or an RTSP URL — only the route name and the resolved
 * facility id (or null when the route does not resolve one at guard time).
 */
export function warnLegacyEdgeUsage(
  route: string,
  facilityId: string | null,
): void {
  logger.warn(
    `legacy shared edge token accepted route=${route} facilityId=${
      facilityId ?? 'unresolved'
    }`,
  );
}
