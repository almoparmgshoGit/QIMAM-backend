import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Phone numbers in old challenges and dead tokens have no reason to be kept. */
@Injectable()
export class AuthCleanupService {
  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async removeExpired(): Promise<void> {
    const now = Date.now();
    // Kept for a day, because the hourly send limit reads recent challenges.
    await this.prisma.otpChallenge.deleteMany({ where: { createdAt: { lt: new Date(now - DAY_MS) } } });
    // Kept for a week, so reuse of a recently expired token is still recognized.
    await this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date(now - 7 * DAY_MS) } } });
  }
}
