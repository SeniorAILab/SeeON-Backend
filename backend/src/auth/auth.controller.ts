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
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
  postLoginPathForUser,
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
import type { RequestWithAuth } from './jwt-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RequireCapability, RolesGuard } from './roles.guard';
import type { AuthenticatedUser } from './auth.types';

@Controller()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @ApiOperation({
    summary: 'Start Kakao login',
    description:
      'Redirects the browser to Kakao OAuth after setting the short-lived OAuth state cookie.',
  })
  @Get('auth/kakao/login')
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

  @ApiOperation({
    summary: 'Complete Kakao login',
    description:
      'Validates the OAuth state, links the Kakao identity to an existing user, sets the JWT auth cookie, and redirects to the appropriate frontend entry point.',
  })
  @Get('auth/kakao/callback')
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
      `${this.frontOrigin()}${postLoginPathForUser(session.user)}`,
    );
  }

  @ApiOperation({
    summary: 'Read authenticated identity',
    description:
      'Reads the JWT auth cookie and returns the authenticated user identity for browser bootstrap.',
  })
  @ApiCookieAuth()
  @Get('auth/me')
  @UseGuards(JwtAuthGuard)
  @Header('cache-control', 'no-store')
  me(@Req() request: RequestWithAuth) {
    if (!request.user) throw new UnauthorizedException('Missing session');
    return presentAuthUser(request.user);
  }

  @ApiOperation({
    summary: 'Log in with email and password',
    description:
      'Authenticates a password user, sets the httpOnly session cookie, and returns the sanitized authenticated user.',
  })
  @Post('auth/login')
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

  @ApiOperation({
    summary: 'Register a facility owner',
    description:
      'Creates the first admin user and facility from the signup form, starts a session, and returns the sanitized authenticated user.',
  })
  @Post('auth/register')
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

  @ApiOperation({
    summary: 'Log out the current user',
    description:
      'Revokes existing JWT cookies by incrementing sessionVersion and clears the browser session cookie.',
  })
  @Post('auth/logout')
  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async logout(
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    if (!request.user) throw new UnauthorizedException('Missing session');
    await this.auth.revokeAllSessions(request.user.id);
    clearSessionCookie(response);
  }

  @ApiOperation({
    summary: 'Create a facility during onboarding',
    description: `Creates the authenticated user's initial facility, upgrades facility context, rotates the session cookie, and returns the updated user.`,
  })
  @Post('facilities')
  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireCapability('facilityAdmin')
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

  private frontOrigin(): string {
    return (
      this.config.get<string>('FRONT_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }
}

function presentAuthUser(
  user: Pick<
    AuthenticatedUser,
    'id' | 'facilityId' | 'role' | 'email' | 'nickname'
  >,
) {
  return {
    id: user.id,
    facilityId: user.facilityId,
    role: user.role,
    email: user.email,
    nickname: user.nickname,
  };
}
