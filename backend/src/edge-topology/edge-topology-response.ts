import type { EntityCounts, MutationResult } from './edge-topology.types.js';

export function presentMutationResult(result: MutationResult) {
  return {
    floors: presentCounts(result.floors),
    rooms: presentCounts(result.rooms),
    cameras: presentCounts(result.cameras),
  };
}

export function confirmationMutationResult(counts: {
  readonly floors: number;
  readonly rooms: number;
  readonly cameras: number;
}) {
  return {
    floors: deactivatedCounts(counts.floors),
    rooms: deactivatedCounts(counts.rooms),
    cameras: deactivatedCounts(counts.cameras),
  };
}

function presentCounts(counts: EntityCounts) {
  return {
    created: counts.created,
    updated: counts.updated,
    unchanged: counts.unchanged,
    ...(counts.reactivated === 0 ? {} : { reactivated: counts.reactivated }),
  };
}

function deactivatedCounts(count: number) {
  return {
    created: 0,
    updated: count,
    unchanged: 0,
    deactivated: count,
  };
}
