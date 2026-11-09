import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessTokenGuard } from './access-token.guard.js';
import { AuthCleanupService } from './auth-cleanup.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OriginGuard } from './origin.guard.js';
import { ConsoleOtpDelivery, OtpDelivery } from './otp-delivery.js';
import { OtpService } from './otp.service.js';
import { LeakedPasswordChecker, PasswordService } from './password.service.js';
import { StaffAuthController } from './staff-auth.controller.js';
import { StaffAuthService } from './staff-auth.service.js';
import { ConsoleStaffMailer, SmtpStaffMailer, StaffMailer } from './staff-mailer.js';
import { TokensService } from './tokens.service.js';
import { TotpService } from './totp.service.js';

@Module({
  controllers: [AuthController, StaffAuthController],
  providers: [
    AuthService,
    OtpService,
    TokensService,
    AccessTokenGuard,
    OriginGuard,
    AuthCleanupService,
    LeakedPasswordChecker,
    PasswordService,
    TotpService,
    StaffAuthService,
    { provide: OtpDelivery, useClass: ConsoleOtpDelivery },
    {
      provide: StaffMailer,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => (config.get('MAIL_DELIVERY') === 'smtp' ? new SmtpStaffMailer(config) : new ConsoleStaffMailer()),
    },
  ],
  exports: [AccessTokenGuard, OriginGuard, TokensService, StaffAuthService],
})
export class AuthModule {}
