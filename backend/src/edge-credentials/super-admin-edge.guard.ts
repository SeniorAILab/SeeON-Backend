import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { RequestWithAuth } from '../auth/jwt-auth.guard.js';

@Injectable()
export class SuperAdminEdgeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<RequestWithAuth>().user;
    if (user === undefined) throw new UnauthorizedException('Missing session');
    if (user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Insufficient role capability');
    }
    return true;
  }
}
