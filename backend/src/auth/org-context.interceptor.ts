import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestWithAuth } from './session.guard';

export type OrgBoundPrismaRunner = <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

@Injectable()
export class OrgContextInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<
        RequestWithAuth & { withOrgContext?: OrgBoundPrismaRunner }
      >();
    if (!request.user) throw new UnauthorizedException('Missing session');
    if (!request.user.orgId)
      throw new ForbiddenException('Organization onboarding required');
    const orgId = request.user.orgId;
    request.withOrgContext = <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ) => this.prisma.withOrgContext<T>(orgId, fn);
    return next.handle();
  }
}
