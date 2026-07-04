import { Injectable } from '@nestjs/common';
import { Prisma, Role, type User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

export type UserSummary = Pick<User, 'id' | 'nickname' | 'email' | 'role'>;

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  listByFacility(facilityId: string): Promise<UserSummary[]> {
    return this.prisma.db.user.findMany({
      where: { facilityId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, nickname: true, email: true, role: true },
    });
  }

  findByEmail(email: string): Promise<Pick<User, 'id'> | null> {
    return this.prisma.db.user.findUnique({
      where: { email },
      select: { id: true },
    });
  }

  createFacilityUser(input: {
    facilityId: string;
    name: string;
    email: string;
    role: Extract<Role, 'ADMIN' | 'STAFF'>;
    passwordHash: string;
  }): Promise<UserSummary> {
    return this.prisma.db.user.create({
      data: {
        facilityId: input.facilityId,
        nickname: input.name,
        email: input.email,
        role: input.role,
        passwordHash: input.passwordHash,
      },
      select: { id: true, nickname: true, email: true, role: true },
    });
  }

  async updateScopedRole(input: {
    id: string;
    facilityId: string;
    role: Extract<Role, 'ADMIN' | 'STAFF'>;
  }): Promise<UserSummary | null> {
    try {
      return await this.prisma.db.user.update({
        where: { id: input.id, facilityId: input.facilityId },
        data: { role: input.role },
        select: { id: true, nickname: true, email: true, role: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        return null;
      }
      throw error;
    }
  }
}
