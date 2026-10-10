import { IsString } from 'class-validator';

// Intentionally undecorated: AuthController.login coerces non-string
// email/password to '' and lets AuthService.loginWithPassword reject the
// result with a uniform 401. Adding @IsString() here would let the pipe
// reject wrong-typed credentials with a 400 instead, leaking a status-code
// distinction the login endpoint deliberately avoids.
export class LoginRequestDto {
  email?: unknown;
  password?: unknown;
}

// Intentionally undecorated: AuthService.registerWithPassword's
// requiredString/requiredPassword helpers already 400 on any non-string or
// blank value; controller-level decorators here would duplicate, not
// tighten, that existing service-layer check.
export class RegisterRequestDto {
  name?: string;
  email?: string;
  password?: string;
  phone?: string;
  facilityName?: string;
}

export class CreateFacilityRequestDto {
  @IsString()
  facilityName!: string;
}

export class UpdateAlertSettingsRequestDto {
  notificationEmail?: string | null;
  emailAlertsEnabled?: boolean;
}
