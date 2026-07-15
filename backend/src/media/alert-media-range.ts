export type ByteSelection =
  | { readonly kind: 'full'; readonly start: 0; readonly end: number }
  | { readonly kind: 'range'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

export type RangeResource = {
  readonly sizeBytes: number;
  readonly etag: string;
  readonly lastModified: Date;
};

const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/;

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
  const resourceSize = BigInt(sizeBytes);

  if (first === '') {
    const suffix = parseDecimalInteger(second);
    if (suffix === null || suffix === 0n) return { kind: 'unsatisfiable' };
    const selectedStart = suffix >= resourceSize ? 0n : resourceSize - suffix;
    return {
      kind: 'range',
      start: Number(selectedStart),
      end: sizeBytes - 1,
    };
  }

  const requestedStart = parseDecimalInteger(first);
  if (requestedStart === null || requestedStart >= resourceSize) {
    return { kind: 'unsatisfiable' };
  }
  const start = Number(requestedStart);
  if (second === '') {
    return { kind: 'range', start, end: sizeBytes - 1 };
  }
  const requestedEnd = parseDecimalInteger(second);
  if (requestedEnd === null || requestedEnd < requestedStart) {
    return { kind: 'unsatisfiable' };
  }
  return {
    kind: 'range',
    start,
    end: Number(
      requestedEnd >= resourceSize ? resourceSize - 1n : requestedEnd,
    ),
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
  const timestamp = parseImfFixdate(header);
  if (timestamp === null) return false;
  return httpSecond(resource.lastModified.getTime()) <= httpSecond(timestamp);
}

function parseDecimalInteger(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function parseImfFixdate(value: string): number | null {
  if (!IMF_FIXDATE.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toUTCString() === value ? timestamp : null;
}

function full(sizeBytes: number): ByteSelection {
  return { kind: 'full', start: 0, end: sizeBytes - 1 };
}

function httpSecond(timestamp: number): number {
  return Math.floor(timestamp / 1_000);
}
