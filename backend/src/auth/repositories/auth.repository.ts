import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  createRegisteredFacilityOwner,
  type RegisteredFacilityOwnerInput,
} from './password-registration.repository';
import { AuthUserNotFoundError } from '../errors/auth-user-not-found.error';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(normalizedEmail: string) {
    return this.prisma.db.user.findFirst({
      where: { email: normalizedEmail },
    });
  }

  findById(userId: string) {
    return this.prisma.db.user.findUnique({
      where: { id: userId },
    });
  }

  createRegisteredFacilityOwner(input: RegisteredFacilityOwnerInput) {
    return createRegisteredFacilityOwner(this.prisma, input);
  }

  createFacilityForUser(userId: string, name: string) {
    return this.prisma.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;

      const current = await tx.user.findUnique({
        where: { id: userId },
      });
      if (!current) throw new AuthUserNotFoundError();
      if (current.facilityId) return current;

      const facility = await tx.facility.create({
        data: { name },
      });
      return tx.user.update({
        where: { id: userId },
        data: { facilityId: facility.id, role: 'ADMIN' },
      });
    });
  }

  incrementSessionVersion(userId: string) {
    return this.prisma.db.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    });
  }

  findSessionVersion(userId: string) {
    return this.prisma.db.user.findUnique({
      where: { id: userId },
      select: { sessionVersion: true },
    });
  }

  findAlertSettings(userId: string) {
    return this.prisma.db.user.findUnique({
      where: { id: userId },
      select: {
        notificationEmail: true,
        emailAlertsEnabled: true,
        email: true,
      },
    });
  }

  updateAlertSettings(
    userId: string,
    data: { notificationEmail?: string | null; emailAlertsEnabled?: boolean },
  ) {
    return this.prisma.db.user.update({
      where: { id: userId },
      data,
      select: {
        notificationEmail: true,
        emailAlertsEnabled: true,
        email: true,
      },
    });
  }
}
