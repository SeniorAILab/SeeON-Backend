import type { Role } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  facilityId: string | null;
  role: Role;
  kakaoId: string | null;
  email: string | null;
  nickname: string;
  sessionVersion: number;
}

export interface AuthenticatedRequest {
  headers: { cookie?: string };
  user?: AuthenticatedUser;
}
