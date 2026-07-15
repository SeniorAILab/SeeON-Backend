export type ByteSelection =
  | { readonly kind: 'full'; readonly start: 0; readonly end: number }
  | { readonly kind: 'range'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

export type RangeResource = {
  readonly sizeBytes: number;
  readonly etag: string;
  readonly lastModified: Date;
};

export function selectByteRange(
  rangeHeader: string | readonly string[] | undefined,
  ifRangeHeader: string | readonly string[] | undefined,
  resource: RangeResource,
): ByteSelection {
  if (rangeHeader === undefined) return full(resource.sizeBytes);
  const selection = parseRequestedRange(rangeHeader, resource.sizeBytes);
  if (selection.kind === 'unsatisfiable') return selection;
  return isIfRangeEligible(ifRangeHeader, resource)
    ? selection
    : full(resource.sizeBytes);
}

function parseRequestedRange(
  rangeHeader: string | readonly string[],
  sizeBytes: number,
):
  | { readonly kind: 'range'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' } {
  if (typeof rangeHeader !== 'string') return { kind: 'unsatisfiable' };
  if (rangeHeader.includes(',')) return { kind: 'unsatisfiable' };

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (match === null) return { kind: 'unsatisfiable' };
  const first = match[1];
  const second = match[2];
  if (first === '' && second === '') return { kind: 'unsatisfiable' };

  if (first === '') {
    const suffix = parseSafeInteger(second);
    if (suffix === null || suffix === 0) return { kind: 'unsatisfiable' };
    return {
      kind: 'range',
      start: Math.max(sizeBytes - suffix, 0),
      end: sizeBytes - 1,
    };
  }

  const start = parseSafeInteger(first);
  if (start === null || start >= sizeBytes) {
    return { kind: 'unsatisfiable' };
  }
  if (second === '') {
    return { kind: 'range', start, end: sizeBytes - 1 };
  }
  const requestedEnd = parseSafeInteger(second);
  if (requestedEnd === null || requestedEnd < start) {
    return { kind: 'unsatisfiable' };
  }
  return {
    kind: 'range',
    start,
    end: Math.min(requestedEnd, sizeBytes - 1),
  };
}

function isIfRangeEligible(
  header: string | readonly string[] | undefined,
  resource: RangeResource,
): boolean {
  if (header === undefined) return true;
  if (typeof header !== 'string' || header.startsWith('W/')) return false;
  if (header === resource.etag) return true;
  if (header.startsWith('"')) return false;
  const timestamp = Date.parse(header);
  if (!Number.isFinite(timestamp)) return false;
  return httpSecond(resource.lastModified.getTime()) <= httpSecond(timestamp);
}

function parseSafeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function full(sizeBytes: number): ByteSelection {
  return { kind: 'full', start: 0, end: sizeBytes - 1 };
}

function httpSecond(timestamp: number): number {
  return Math.floor(timestamp / 1_000);
}
