import { Module } from '@nestjs/common';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './controllers/auth.controller';
import { AuthService } from './services/auth.service';
import { AuthRepository } from './repositories/auth.repository';
import { FacilityContextInterceptor } from './interceptors/facility-context.interceptor';
import { RequireFacilityGuard, JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { JwtStrategyAdapter, jwtSecret } from './adapters/jwt-strategy.adapter';
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
    AuthRepository,
    JwtAuthGuard,
    JwtStrategyAdapter,
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
