import type { Role } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  orgId: string | null;
  role: Role;
  kakaoId: string;
  nickname: string;
  sessionVersion: number;
}

export interface AuthenticatedRequest {
  headers: { cookie?: string };
  user?: AuthenticatedUser;
  sessionId?: string;
}

export interface CreateOrganizationBody {
  facilityName?: unknown;
  businessRegistrationNumber?: unknown;
}
