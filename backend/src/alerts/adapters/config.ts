import { ConfigService } from '@nestjs/config';

export function readPositiveIntegerConfig(
  configService: ConfigService,
  name: string,
  defaultValue: number,
): number {
  const configured = configService.get<string | number>(name);
  if (typeof configured === 'number' && configured > 0) {
    return Math.trunc(configured);
  }
  if (typeof configured === 'string') {
    const parsed = Number(configured);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return defaultValue;
}
