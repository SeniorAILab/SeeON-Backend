import { ConflictException } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

export interface RegisteredFacilityOwnerInput {
  readonly facilityName: string;
  readonly normalizedEmail: string;
  readonly passwordHash: string;
  readonly phone: string;
  readonly name: string;
}

export async function createRegisteredFacilityOwner(
  prisma: PrismaService,
  input: RegisteredFacilityOwnerInput,
): Promise<User> {
  try {
    return await prisma.db.$transaction(async (tx) => {
      const facility = await tx.facility.create({
        data: { name: input.facilityName },
      });
      return tx.user.create({
        data: {
          facilityId: facility.id,
          email: input.normalizedEmail,
          passwordHash: input.passwordHash,
          phone: input.phone,
          nickname: input.name,
          role: 'ADMIN',
        },
      });
    });
  } catch (error) {
    if (
      isUniqueConstraintError(error) &&
      uniqueTargetIncludes(error, 'email')
    ) {
      throw new ConflictException('Email already registered');
    }
    throw error;
  }
}

function isUniqueConstraintError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function uniqueTargetIncludes(
  error: Prisma.PrismaClientKnownRequestError,
  target: string,
): boolean {
  const rawTarget = error.meta?.target;
  if (Array.isArray(rawTarget)) return rawTarget.includes(target);
  return rawTarget === target;
}
