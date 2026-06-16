import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OrgContextInterceptor } from './org-context.interceptor';
import { RequireOrgGuard, SessionGuard } from './session.guard';
import { KakaoClient } from './kakao.client';
import { SessionService } from './session.service';

@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    KakaoClient,
    SessionService,
    SessionGuard,
    RequireOrgGuard,
    OrgContextInterceptor,
  ],
  exports: [
    SessionService,
    AuthService,
    SessionGuard,
    RequireOrgGuard,
    OrgContextInterceptor,
  ],
})
export class AuthModule {}
