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

export type FacilityBoundPrismaRunner = <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

@Injectable()
export class FacilityContextInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<
        RequestWithAuth & { withFacilityContext?: FacilityBoundPrismaRunner }
      >();
    if (!request.user) throw new UnauthorizedException('Missing session');
    if (!request.user.facilityId)
      throw new ForbiddenException('Facility onboarding required');
    const facilityId = request.user.facilityId;
    request.withFacilityContext = <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ) => this.prisma.withFacilityContext<T>(facilityId, fn);
    return next.handle();
  }
}
