import { BadRequestException } from '@nestjs/common';

export const PASSWORD_MIN_CODE_POINTS = 8;
export const PASSWORD_MAX_CODE_POINTS = 128;

export function requiredPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestException('password is required');
  }
  return value;
}

export function assertValidPassword(password: string): void {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_CODE_POINTS) {
    throw new BadRequestException(
      `password must be at least ${PASSWORD_MIN_CODE_POINTS} characters`,
    );
  }
  if (length > PASSWORD_MAX_CODE_POINTS) {
    throw new BadRequestException(
      `password must be at most ${PASSWORD_MAX_CODE_POINTS} characters`,
    );
  }
}
