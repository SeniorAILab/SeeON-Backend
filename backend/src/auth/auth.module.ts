import { Module } from '@nestjs/common';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FacilityContextInterceptor } from './facility-context.interceptor';
import { RequireFacilityGuard, JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { KakaoClient } from './kakao.client';
import { JwtStrategy, jwtSecret } from './jwt.strategy';
import { DEFAULT_JWT_TTL } from './auth.constants';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: jwtSecret(config),
        signOptions: {
          expiresIn: (config.get<string>('JWT_TTL') ??
            DEFAULT_JWT_TTL) as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    KakaoClient,
    JwtAuthGuard,
    JwtStrategy,
    RequireFacilityGuard,
    RolesGuard,
    FacilityContextInterceptor,
  ],
  exports: [
    JwtAuthGuard,
    AuthService,
    RequireFacilityGuard,
    RolesGuard,
    FacilityContextInterceptor,
  ],
})
export class AuthModule {}
