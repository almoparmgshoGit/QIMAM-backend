import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { APNS_TOKEN, ApnsClient } from './apns.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** The most messages Expo takes in one request. */
const BATCH = 100;

export interface PushMessage {
  /** The stored notification it announces, so a tap can open it. */
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Where a tap leads, for a notification about one thing in particular. */
  opens?: { opens: string; ticketId: string } | null;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/**
 * Sends stored notifications on to the student's phones: an iPhone's own APNs token straight to Apple when the
 * APNs key is set, and an Expo token through Expo's push service.
 * The notification is already saved, so a failure here only costs the banner, never the message.
 */
@Injectable()
export class PushService implements OnModuleDestroy {
  private readonly logger = new Logger('Push');
  private readonly accessToken: string | undefined;
  private readonly enabled: boolean;
  private readonly apns: ApnsClient | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.accessToken = config.get<string>('EXPO_ACCESS_TOKEN');
    // The tests must never reach a real service.
    this.enabled = config.get<string>('NODE_ENV') !== 'test';
    const keyId = config.get<string>('APNS_KEY_ID');
    const teamId = config.get<string>('APNS_TEAM_ID');
    const key = config.get<string>('APNS_PRIVATE_KEY_BASE64');
    this.apns =
      keyId && teamId && key
        ? new ApnsClient({
            keyId,
            teamId,
            privateKey: Buffer.from(key, 'base64').toString('utf8'),
            topic: config.get<string>('APNS_TOPIC') ?? 'com.qimam.quran',
          })
        : null;
  }

  onModuleDestroy(): void {
    this.apns?.close();
  }

  async registerDevice(userId: string, pushToken: string, platform: 'IOS' | 'ANDROID'): Promise<void> {
    // A phone passed to another student moves with its token, so the last one to sign in owns it.
    await this.prisma.pushDevice.upsert({
      where: { pushToken },
      create: { userId, pushToken, platform },
      update: { userId, platform, lastSeenAt: new Date() },
    });
  }

  /** On sign-out: this phone stops receiving the student's notifications. */
  async removeDevice(userId: string, pushToken: string): Promise<void> {
    await this.prisma.pushDevice.deleteMany({ where: { userId, pushToken } });
  }

  async deliver(messages: PushMessage[]): Promise<void> {
    if (!this.enabled || messages.length === 0) return;
    const devices = await this.prisma.pushDevice.findMany({
      where: { userId: { in: [...new Set(messages.map(({ userId }) => userId))] } },
      select: { userId: true, pushToken: true },
    });
    if (devices.length === 0) return;

    const tokensByUser = new Map<string, string[]>();
    for (const { userId, pushToken } of devices) tokensByUser.set(userId, [...(tokensByUser.get(userId) ?? []), pushToken]);

    const pairs = messages.flatMap((message) => (tokensByUser.get(message.userId) ?? []).map((to) => ({ message, to })));
    const direct = pairs.filter(({ to }) => APNS_TOKEN.test(to));
    if (direct.length > 0) await this.deliverToApple(direct);

    const outgoing = pairs
      .filter(({ to }) => !APNS_TOKEN.test(to))
      .map(({ message, to }) => ({
        to,
        title: message.title,
        body: message.body,
        sound: 'default',
        channelId: 'default',
        priority: 'high',
        data: { notificationId: message.id, type: message.type, ...message.opens },
      }));

    for (let start = 0; start < outgoing.length; start += BATCH) {
      const batch = outgoing.slice(start, start + BATCH);
      try {
        const tickets = await this.post(batch);
        const gone = batch.filter((_, index) => tickets[index]?.details?.error === 'DeviceNotRegistered').map(({ to }) => to);
        // The app was removed or the token replaced: sending there again only fails again.
        if (gone.length > 0) await this.prisma.pushDevice.deleteMany({ where: { pushToken: { in: gone } } });
        const failed = tickets.filter(({ status, details }) => status === 'error' && details?.error !== 'DeviceNotRegistered');
        if (failed.length > 0) this.logger.warn(`${failed.length} push messages refused: ${failed[0].details?.error ?? failed[0].message}`);
      } catch (error) {
        this.logger.warn(`Push batch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async deliverToApple(pairs: { message: PushMessage; to: string }[]): Promise<void> {
    if (!this.apns) {
      this.logger.warn(`${pairs.length} iPhone push messages skipped: APNS_KEY_ID, APNS_TEAM_ID and APNS_PRIVATE_KEY_BASE64 are not set`);
      return;
    }
    const apns = this.apns;
    const results = await Promise.all(
      pairs.map(({ message, to }) =>
        apns.send(to, {
          title: message.title,
          body: message.body,
          data: { notificationId: message.id, type: message.type, ...message.opens },
        }),
      ),
    );
    const gone = pairs.filter((_, index) => !results[index].ok && (results[index] as { gone: boolean }).gone).map(({ to }) => to);
    if (gone.length > 0) await this.prisma.pushDevice.deleteMany({ where: { pushToken: { in: gone } } });
    const failed = results.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok && !r.gone);
    if (failed.length > 0) this.logger.warn(`${failed.length} iPhone push messages refused: ${failed[0].reason}`);
  }

  private async post(batch: object[]): Promise<ExpoTicket[]> {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(this.accessToken && { Authorization: `Bearer ${this.accessToken}` }),
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Expo push answered ${response.status}`);
    const { data } = (await response.json()) as { data?: ExpoTicket[] };
    return data ?? [];
  }
}
