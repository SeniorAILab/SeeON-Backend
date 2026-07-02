import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RbacCapability } from './auth.constants';
import { hasRbacCapability, isAuthRole } from './auth.constants';
import type { RequestWithAuth } from './jwt-auth.guard';

export const REQUIRED_CAPABILITY_METADATA_KEY = 'requiredRbacCapability';

export const RequireCapability = (capability: RbacCapability) =>
  SetMetadata(REQUIRED_CAPABILITY_METADATA_KEY, capability);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const capability = this.reflector.getAllAndOverride<
      RbacCapability | undefined
    >(REQUIRED_CAPABILITY_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!capability) return true;

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const role = request.user?.role;
    if (!role) throw new UnauthorizedException('Missing session');
    if (!isAuthRole(role)) throw new ForbiddenException('Unknown role');
    if (!hasRbacCapability(role, capability)) {
      throw new ForbiddenException('Insufficient role capability');
    }
    return true;
  }
}
