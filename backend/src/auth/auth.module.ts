import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FacilityContextInterceptor } from './facility-context.interceptor';
import { RequireFacilityGuard, SessionGuard } from './session.guard';
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
    RequireFacilityGuard,
    FacilityContextInterceptor,
  ],
  exports: [
    SessionService,
    AuthService,
    SessionGuard,
    RequireFacilityGuard,
    FacilityContextInterceptor,
  ],
})
export class AuthModule {}
