import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiError } from '../common/api-error.js';
import { Public } from './public.decorator.js';
import { clearStaffCookies, setStaffCookies, STAFF_REFRESH_COOKIE } from './staff-cookies.js';
import {
  type ChangePasswordDto,
  changePasswordSchema,
  type ForgotPasswordDto,
  forgotPasswordSchema,
  type MfaCodeDto,
  mfaCodeSchema,
  type MfaTokenDto,
  mfaTokenSchema,
  type SetPasswordDto,
  setPasswordSchema,
  type StaffLoginDto,
  staffLoginSchema,
} from './staff-auth.schemas.js';
import { StaffAuthService } from './staff-auth.service.js';
import { CurrentStaff, Dashboard, Roles, type StaffActor } from './staff.decorators.js';
import { REFRESH_TOKEN_PATTERN, TokensService } from './tokens.service.js';

const MINUTE_MS = 60_000;

const readRefreshCookie = (request: Request): string | undefined => {
  const value = (request.cookies as Record<string, string | undefined>)[STAFF_REFRESH_COOKIE];
  return value && REFRESH_TOKEN_PATTERN.test(value) ? value : undefined;
};

// These limits are per IP address. The account lock adds a limit per person, which no IP change can avoid.
@Dashboard()
@Controller('staff/auth')
export class StaffAuthController {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly tokens: TokensService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 15 * MINUTE_MS } })
  @Post('login')
  @HttpCode(200)
  async login(@Body({ schema: staffLoginSchema }) body: StaffLoginDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(body);
    if (result.next !== 'done') return result;
    setStaffCookies(response, result.tokens);
    return { next: 'done' };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 15 * MINUTE_MS } })
  @Post('totp/verify')
  @HttpCode(200)
  async verifyTotp(@Body({ schema: mfaCodeSchema }) body: MfaCodeDto, @Res({ passthrough: true }) response: Response) {
    setStaffCookies(response, await this.auth.verifyTotp(body));
    return { next: 'done' };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE_MS } })
  @Post('totp/enroll')
  @HttpCode(200)
  startEnrollment(@Body({ schema: mfaTokenSchema }) body: MfaTokenDto) {
    return this.auth.startEnrollment(body.mfaToken);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 15 * MINUTE_MS } })
  @Post('totp/confirm')
  @HttpCode(200)
  async confirmEnrollment(@Body({ schema: mfaCodeSchema }) body: MfaCodeDto, @Res({ passthrough: true }) response: Response) {
    setStaffCookies(response, await this.auth.confirmEnrollment(body));
    return { next: 'done' };
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: MINUTE_MS } })
  @Post('refresh')
  @HttpCode(204)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = readRefreshCookie(request);
    if (!token) throw new ApiError(401, 'invalid_refresh_token');
    try {
      setStaffCookies(response, await this.tokens.rotate(token, 'DASHBOARD'));
    } catch (error) {
      clearStaffCookies(response);
      throw error;
    }
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = readRefreshCookie(request);
    if (token) await this.tokens.revokeByToken(token);
    clearStaffCookies(response);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 15 * MINUTE_MS } })
  @Post('password/forgot')
  @HttpCode(204)
  forgotPassword(@Body({ schema: forgotPasswordSchema }) body: ForgotPasswordDto): void {
    this.auth.requestPasswordRecovery(body.email);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE_MS } })
  @Post('password/set')
  @HttpCode(204)
  async setPassword(@Body({ schema: setPasswordSchema }) body: SetPasswordDto) {
    await this.auth.setPassword(body);
  }

  @Roles('TEACHER', 'SUPERVISOR', 'ADMIN')
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE_MS } })
  @Post('password/change')
  @HttpCode(204)
  async changePassword(
    @CurrentStaff() staff: StaffActor,
    @Body({ schema: changePasswordSchema }) body: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    setStaffCookies(response, await this.auth.changePassword(staff.id, body));
  }

  @Roles('TEACHER', 'SUPERVISOR', 'ADMIN')
  @Get('me')
  me(@CurrentStaff() staff: StaffActor) {
    return this.auth.profile(staff.id);
  }
}
