import type { User } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

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
}
