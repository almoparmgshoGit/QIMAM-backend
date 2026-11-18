import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../common/api-error.js';
import type { OtpPurpose } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OtpDelivery } from './otp-delivery.js';

const CODE_MAX = 1_000_000;
const CODE_LENGTH = 6;
const CODE_LIFETIME_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODES_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly pepper: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly delivery: OtpDelivery,
  ) {
    this.pepper = config.getOrThrow<string>('OTP_PEPPER');
  }

  /**
   * Behaves the same whether or not the number has an account, so this step reveals nothing about who is
   * registered. Delivery is not awaited, so its duration reveals nothing either.
   */
  async request(phone: string, purpose: OtpPurpose): Promise<void> {
    // When the provider makes the code, this server never sees it and stores no hash.
    const code = this.delivery.providerIssuesCodes ? null : String(randomInt(CODE_MAX)).padStart(CODE_LENGTH, '0');
    const now = Date.now();

    await this.prisma.$transaction(async (tx) => {
      // Serializes requests for one number, so simultaneous requests cannot slip past the limits.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${phone}::text, 0))::text`;

      const recent = await tx.otpChallenge.findMany({
        where: { phone, createdAt: { gte: new Date(now - HOUR_MS) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const latest = recent[0];
      if (latest && now - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
        const waitMs = RESEND_COOLDOWN_MS - (now - latest.createdAt.getTime());
        throw new ApiError(429, 'otp_cooldown', { retryAfterSeconds: Math.ceil(waitMs / 1000) });
      }
      const oldest = recent.at(-1);
      if (oldest && recent.length >= MAX_CODES_PER_HOUR) {
        const waitMs = HOUR_MS - (now - oldest.createdAt.getTime());
        throw new ApiError(429, 'otp_hourly_limit', { retryAfterSeconds: Math.ceil(waitMs / 1000) });
      }

      // Only the newest code stays valid.
      await tx.otpChallenge.updateMany({
        where: { phone, consumedAt: null },
        data: { consumedAt: new Date(now) },
      });
      await tx.otpChallenge.create({
        data: {
          phone,
          purpose,
          codeHmac: code === null ? null : this.hmac(phone, code),
          expiresAt: new Date(now + CODE_LIFETIME_MS),
        },
      });
    });

    // A failed delivery looks like a code that never arrived, and the student can ask again after the cooldown.
    void this.delivery.deliver(phone, code).catch((error: unknown) => {
      this.logger.error(`Code delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
  }

  /** Every failure throws the same error. */
  async verify(phone: string, code: string): Promise<void> {
    const invalid = new ApiError(401, 'invalid_code');
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) throw invalid;

    // Counted before comparing, so simultaneous guesses cannot exceed the limit.
    const counted = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, attempts: { lt: challenge.maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count !== 1) throw invalid;

    const correct =
      challenge.codeHmac === null ? await this.checkWithProvider(phone, code) : this.matches(challenge.codeHmac, phone, code);
    if (!correct) throw invalid;

    // A code signs in once, even if two requests carry it at the same moment.
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid;
  }

  private matches(codeHmac: string, phone: string, code: string): boolean {
    return timingSafeEqual(Buffer.from(codeHmac, 'hex'), Buffer.from(this.hmac(phone, code), 'hex'));
  }

  /** The attempt stays counted when the provider can't answer, so an outage can't be used to guess for free. */
  private async checkWithProvider(phone: string, code: string): Promise<boolean> {
    try {
      return await this.delivery.check(phone, code);
    } catch (error: unknown) {
      this.logger.error(`Code check failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new ApiError(503, 'otp_unavailable');
    }
  }

  private hmac(phone: string, code: string): string {
    return createHmac('sha256', this.pepper).update(`${phone}:${code}`).digest('hex');
  }
}
