import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { clearSessionCookie, setSessionCookie } from './cookie.util';
import {
  CreateFacilityRequestDto,
  LoginRequestDto,
  RegisterRequestDto,
  UpdateAlertSettingsRequestDto,
} from './dto/auth.dto';
import type { RequestWithAuth } from './jwt-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RequireCapability, RolesGuard } from './roles.guard';
import type { AuthenticatedUser } from './auth.types';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
    summary: 'Read the current user email-alert settings',
    description:
      'Returns the authenticated user notification_email, email_alerts_enabled flag, and the effective recipient email (notification_email ?? email).',
  })
  @ApiCookieAuth()
  @Get('auth/me/alert-settings')
  @UseGuards(JwtAuthGuard)
  @Header('cache-control', 'no-store')
  async getAlertSettings(@Req() request: RequestWithAuth) {
    if (!request.user) throw new UnauthorizedException('Missing session');
    return this.auth.getAlertSettings(request.user.id);
  }

  @ApiOperation({
    summary: 'Update the current user email-alert settings',
    description:
      'Self-service update of notification_email (null/empty clears it, falling back to the login email) and email_alerts_enabled.',
  })
  @ApiCookieAuth()
  @ApiBody({ type: UpdateAlertSettingsRequestDto })
  @Patch('auth/me/alert-settings')
  @UseGuards(JwtAuthGuard)
  async updateAlertSettings(
    @Req() request: RequestWithAuth,
    @Body() body: UpdateAlertSettingsRequestDto,
  ) {
    if (!request.user) throw new UnauthorizedException('Missing session');
    return this.auth.updateAlertSettings(request.user.id, {
      notificationEmail: body.notificationEmail,
      emailAlertsEnabled: body.emailAlertsEnabled,
    });
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
    const session = await this.auth.createFacilityForUser(
      request.user.id,
      body.facilityName,
    );
    setSessionCookie(response, session.token, session.maxAgeSeconds);
    return { user: presentAuthUser(session.user) };
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
