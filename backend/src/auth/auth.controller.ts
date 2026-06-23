import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
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
import type { CreateFacilityRequestDto } from './dto/auth.dto';
import { SessionService } from './session.service';
import type { RequestWithAuth } from './session.guard';
import { RequireFacilityGuard, SessionGuard } from './session.guard';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Get('/auth/kakao/login')
  kakaoLogin(@Res() response: Response): void {
    const state = this.auth.createOAuthState();
    setOAuthStateCookie(response, state, OAUTH_STATE_TTL_SECONDS);
    response.redirect(this.auth.getKakaoAuthorizeUrl(state));
  }

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
    const session = await this.auth.completeKakaoCallback(code ?? '');
    clearOAuthStateCookie(response);
    setSessionCookie(response, session.token, session.maxAgeSeconds);
    const frontOrigin = (
      this.config.get<string>('FRONT_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    // Backend OAuth callbacks run on :8080; relative redirects would land on missing :8080 frontend routes.
    response.redirect(
      `${frontOrigin}${session.user.facilityId ? '/dashboard' : '/onboarding'}`,
    );
  }

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
    return { user: valid.user };
  }

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

  @Post('/api/facilities')
  @UseGuards(SessionGuard)
  async createFacility(
    @Body() body: CreateFacilityRequestDto,
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!request.user) throw new BadRequestException('Missing user');
    const facilityName =
      typeof body.facilityName === 'string' ? body.facilityName : '';
    const businessRegistrationNumber =
      typeof body.businessRegistrationNumber === 'string' &&
      body.businessRegistrationNumber.trim()
        ? body.businessRegistrationNumber.trim()
        : null;
    const session = await this.auth.createFacilityForUser(
      request.user.id,
      facilityName,
      businessRegistrationNumber,
    );
    setSessionCookie(response, session.token, session.maxAgeSeconds);
    return { user: session.user };
  }

  @Get('/api/protected-probe')
  @UseGuards(SessionGuard)
  @Header('cache-control', 'no-store')
  protectedProbe(
    @Req() request: RequestWithAuth,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.refreshRotatedCookie(request, response);
    return { user: request.user };
  }

  @Get('/api/facility-protected-probe')
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
}
