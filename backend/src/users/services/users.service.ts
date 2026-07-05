import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../../auth/password.js';
import {
  assertValidPassword,
  requiredPassword,
} from '../../auth/password-policy.js';
import type {
  CreateUserResponseDto,
  UserResponseDto,
} from '../dto/user.dto.js';
import {
  UsersRepository,
  type UserSummary,
} from '../repositories/users.repository.js';

export interface CreateFacilityUserInput {
  readonly facilityId: string;
  readonly name: unknown;
  readonly email: unknown;
  readonly role: unknown;
  readonly initialPassword: unknown;
}

@Injectable()
export class UsersService {
  constructor(private readonly users: UsersRepository) {}

  async list(facilityId: string): Promise<UserResponseDto[]> {
    return (await this.users.listByFacility(facilityId)).map(presentUser);
  }

  async create(input: CreateFacilityUserInput): Promise<CreateUserResponseDto> {
    const name = requiredString(input.name, 'name');
    const email = normalizeEmail(requiredString(input.email, 'email'));
    const role = requireAssignableFacilityRole(input.role);
    const initialPassword = resolveInitialPassword(input.initialPassword);

    if (await this.users.findByEmail(email)) {
      throw new ConflictException('Email already registered');
    }

    let user: UserSummary;
    try {
      user = await this.users.createFacilityUser({
        facilityId: input.facilityId,
        name,
        email,
        role,
        passwordHash: await hashPassword(initialPassword),
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('Email already registered');
      }
      throw error;
    }

    return { user: presentUser(user), initialPassword };
  }

  async updateRole(
    id: string,
    facilityId: string,
    roleValue: unknown,
  ): Promise<UserResponseDto> {
    const role = requireAssignableFacilityRole(roleValue);
    const user = await this.users.updateScopedRole({ id, facilityId, role });
    if (!user) throw new NotFoundException('User not found');
    return presentUser(user);
  }
}

function presentUser(user: UserSummary): UserResponseDto {
  return {
    id: user.id,
    name: user.nickname,
    email: user.email,
    role: user.role,
  };
}

function requireAssignableFacilityRole(
  value: unknown,
): Extract<Role, 'ADMIN' | 'STAFF'> {
  if (value === Role.ADMIN || value === Role.STAFF) return value;
  throw new BadRequestException('Only ADMIN and STAFF roles may be assigned');
}

function resolveInitialPassword(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return randomBytes(12).toString('base64url');
  }
  const password = requiredPassword(value);
  assertValidPassword(password);
  return password;
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new BadRequestException(`${fieldName} is required`);
  return trimmed;
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new BadRequestException('email is required');
  return normalized;
}
