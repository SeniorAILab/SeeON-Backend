export const AlertStatuses = ['NEW', 'ACKED', 'RESOLVED'] as const;

export type AlertStatusDto = (typeof AlertStatuses)[number];

export function parseAlertStatus(
  value: string | undefined,
): AlertStatusDto | undefined {
  return AlertStatuses.find((status) => status === value);
}
