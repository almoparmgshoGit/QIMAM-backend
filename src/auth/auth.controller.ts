import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type CompleteRegistrationDto,
  completeRegistrationSchema,
  type RefreshTokenDto,
  refreshTokenSchema,
  type RequestOtpDto,
  requestOtpSchema,
  type VerifyOtpDto,
  verifyOtpSchema,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';
import { TokensService } from './tokens.service.js';

const MINUTE_MS = 60_000;

// These limits are per IP address. OtpService adds limits per phone number, which no IP change can avoid.
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
  ) {}

  @Throttle({ default: { limit: 20, ttl: 60 * MINUTE_MS } })
  @Post('otp/request')
  @HttpCode(202)
  async requestOtp(@Body({ schema: requestOtpSchema }) body: RequestOtpDto) {
    await this.auth.requestOtp(body);
    return { status: 'sent' };
  }

  @Throttle({ default: { limit: 30, ttl: 15 * MINUTE_MS } })
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body({ schema: verifyOtpSchema }) body: VerifyOtpDto) {
    return this.auth.verifyOtp(body);
  }

  @Throttle({ default: { limit: 30, ttl: 15 * MINUTE_MS } })
  @Post('register')
  @HttpCode(201)
  completeRegistration(@Body({ schema: completeRegistrationSchema }) body: CompleteRegistrationDto) {
    return this.auth.completeRegistration(body);
  }

  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body({ schema: refreshTokenSchema }) body: RefreshTokenDto) {
    return this.tokens.rotate(body.refreshToken);
  }

  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @Post('logout')
  @HttpCode(204)
  async logout(@Body({ schema: refreshTokenSchema }) body: RefreshTokenDto) {
    await this.tokens.revokeByToken(body.refreshToken);
  }
}
