import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
  VERSION_NEUTRAL,
  Version,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
  SESSION_COOKIE_NAME,
} from './auth.constants';
import { AuthService } from './auth.service';
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  readCookie,
  setOAuthStateCookie,
  setSessionCookie,
} from './cookie.util';
import type {
  CreateFacilityRequestDto,
  LoginRequestDto,
  RegisterRequestDto,
} from './dto/auth.dto';
import { SessionService } from './session.service';
import type { RequestWithAuth } from './session.guard';
import { RequireFacilityGuard, SessionGuard } from './session.guard';
import type { AuthenticatedUser } from './auth.types';

@Controller()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Version(VERSION_NEUTRAL)
  @Get('/auth/kakao/login')
  kakaoLogin(@Res() response: Response): void {
    const state = this.auth.createOAuthState();
    let authorizeUrl: string;
    try {
      authorizeUrl = this.auth.getKakaoAuthorizeUrl(state);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        this.logger.warn(`Kakao OAuth unavailable: ${error.message}`);
        response.redirect(
          `${this.frontOrigin()}/login?auth_error=kakao_unavailable`,
        );
        return;
      }
      throw error;
    }
    setOAuthStateCookie(response, state, OAUTH_STATE_TTL_SECONDS);
    response.redirect(authorizeUrl);
  }

  @Version(VERSION_NEUTRAL)
  @Get('/auth/kakao/callback')
  async kakaoCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() request: RequestWithAuth,
    @Res() response: Response,
  ): Promise<void> {
    const expectedState = readCookie(
      request.headers.cookie,
      OAUTH_STATE_COOKIE_NAME,
    );
    if (!state || !expectedState || state !== expectedState) {
      throw new BadRequestException('Invalid OAuth state');
    }
    let session: Awaited<ReturnType<AuthService['completeKakaoCallback']>>;
    try {
      session = await this.auth.completeKakaoCallback(code ?? '');
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        clearOAuthStateCookie(response);
        response.redirect(
          `${this.frontOrigin()}/login?auth_error=kakao_unregistered`,
        );
        return;
      }
      throw error;
    }
    clearOAuthStateCookie(response);
    setSessionCookie(response, session.token, session.maxAgeSeconds);
    // Backend OAuth callbacks run on :8080; relative redirects would land on missing :8080 frontend routes.
    response.redirect(
      `${this.frontOrigin()}${this.postLoginPath(session.user)}`,
    );
  }

  @Version(VERSION_NEUTRAL)
  @Get('/auth/session')
  @Header('cache-control', 'no-store')
  async sessionForServerRender(
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    const valid = await this.sessions.validateToken(token);
    if (valid.rotatedToken) {
      setSessionCookie(response, valid.rotatedToken, valid.maxAgeSeconds);
    }
    return { user: presentAuthUser(valid.user) };
  }

  @Version(VERSION_NEUTRAL)
  @Post('/auth/login')
  @HttpCode(200)
  async login(
    @Body() body: LoginRequestDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.loginWithPassword(
      typeof body.email === 'string' ? body.email : '',
      typeof body.password === 'string' ? body.password : '',
    );
    setSessionCookie(response, session.token, session.maxAgeSeconds);
    return { user: presentAuthUser(session.user) };
  }

  @Version(VERSION_NEUTRAL)
  @Post('/auth/register')
  async register(
    @Body() body: RegisterRequestDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.registerWithPassword({
      name: body.name,
      email: body.email,
      password: body.password,
      phone: body.phone,
      facilityName: body.facilityName,
    });
    setSessionCookie(response, session.token, session.maxAgeSeconds);
    return { user: presentAuthUser(session.user) };
  }

  @Version(VERSION_NEUTRAL)
  @Post('/auth/logout')
  @UseGuards(SessionGuard)
  @HttpCode(204)
  async logout(
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    if (request.sessionId) await this.sessions.revoke(request.sessionId);
    clearSessionCookie(response);
  }

  @Post('facilities')
  @UseGuards(SessionGuard)
  async createFacility(
    @Body() body: CreateFacilityRequestDto,
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!request.user) throw new BadRequestException('Missing user');
    const facilityName =
      typeof body.facilityName === 'string' ? body.facilityName : '';
    const session = await this.auth.createFacilityForUser(
      request.user.id,
      facilityName,
    );
    setSessionCookie(response, session.token, session.maxAgeSeconds);
    return { user: presentAuthUser(session.user) };
  }

  @Get('protected-probe')
  @UseGuards(SessionGuard)
  @Header('cache-control', 'no-store')
  protectedProbe(
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.refreshRotatedCookie(request, response);
    return { user: request.user ? presentAuthUser(request.user) : null };
  }

  @Get('facility-protected-probe')
  @UseGuards(SessionGuard, RequireFacilityGuard)
  @Header('cache-control', 'no-store')
  facilityProtectedProbe(
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.refreshRotatedCookie(request, response);
    return { facilityId: request.user?.facilityId };
  }

  private refreshRotatedCookie(
    request: RequestWithAuth,
    response: Response,
  ): void {
    if (request.rotatedSessionToken && request.rotatedSessionMaxAgeSeconds) {
      setSessionCookie(
        response,
        request.rotatedSessionToken,
        request.rotatedSessionMaxAgeSeconds,
      );
    }
  }

  private frontOrigin(): string {
    return (
      this.config.get<string>('FRONT_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  private postLoginPath(
    user: Pick<AuthenticatedUser, 'facilityId' | 'role'>,
  ): string {
    if (!user.facilityId) return '/onboarding';
    return user.role === 'ADMIN' || user.role === 'SUPER_ADMIN'
      ? '/dashboard'
      : '/now';
  }
}

function presentAuthUser(
  user: Pick<
    AuthenticatedUser,
    | 'id'
    | 'facilityId'
    | 'role'
    | 'kakaoId'
    | 'email'
    | 'nickname'
    | 'sessionVersion'
  >,
) {
  return {
    id: user.id,
    facilityId: user.facilityId,
    role: user.role,
    kakaoId: user.kakaoId,
    email: user.email,
    nickname: user.nickname,
    sessionVersion: user.sessionVersion,
  };
}
