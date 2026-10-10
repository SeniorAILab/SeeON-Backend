import type { Role } from '@prisma/client';

export interface UserResponseDto {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: Role;
}

export interface CreateUserResponseDto {
  readonly user: UserResponseDto;
  readonly initialPassword: string;
}
