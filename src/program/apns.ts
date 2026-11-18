import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { sign } from 'node:crypto';

/** An iPhone's own APNs device token, as the app reads it from the system: hex, usually 64 characters. */
export const APNS_TOKEN = /^[0-9a-f]{64,200}$/i;

export interface ApnsSettings {
  keyId: string;
  teamId: string;
  /** The .p8 key's PEM text. */
  privateKey: string;
  /** The app's bundle id. */
  topic: string;
}

export interface ApnsAlert {
  title: string;
  body: string;
  /** Read by the app on a tap. expo-notifications takes a remote notification's data from the "body" key. */
  data: Record<string, unknown>;
}

/** Apple's answer for one device. `gone` means the token will never work again on either host. */
export type ApnsResult =
  { ok: true } | { ok: false; gone: boolean; reason: string };

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;
/** Apple accepts a provider token for up to an hour and refuses refreshing it more than every 20 minutes. */
const TOKEN_LIFETIME_MS = 40 * 60 * 1000;

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString('base64url');

/** The provider token: an ES256 JWT signed with the team's APNs key. */
export function providerToken(
  settings: Pick<ApnsSettings, 'keyId' | 'teamId' | 'privateKey'>,
  nowMs = Date.now(),
): string {
  const header = base64url(
    JSON.stringify({ alg: 'ES256', kid: settings.keyId }),
  );
  const claims = base64url(
    JSON.stringify({ iss: settings.teamId, iat: Math.floor(nowMs / 1000) }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: settings.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${claims}.${base64url(signature)}`;
}

export function apnsPayload(alert: ApnsAlert): string {
  return JSON.stringify({
    aps: { alert: { title: alert.title, body: alert.body }, sound: 'default' },
    body: alert.data,
  });
}

/**
 * Sends straight to Apple, the same way for every iPhone build. A store or TestFlight build has a production token
 * and a build from Xcode a sandbox one, and the token alone does not say which, so a token the production host
 * calls bad is tried once on the sandbox host.
 */
export class ApnsClient {
  private token: { value: string; madeAt: number } | null = null;
  private readonly sessions = new Map<keyof typeof HOSTS, ClientHttp2Session>();

  constructor(private readonly settings: ApnsSettings) {}

  async send(deviceToken: string, alert: ApnsAlert): Promise<ApnsResult> {
    const payload = apnsPayload(alert);
    const first = await this.post('production', deviceToken, payload);
    if (first.ok || first.reason !== 'BadDeviceToken') return first;
    const second = await this.post('sandbox', deviceToken, payload);
    // Bad on both hosts: the token belongs to another app or was never valid.
    return second.ok
      ? second
      : {
          ok: false,
          gone: second.gone || second.reason === 'BadDeviceToken',
          reason: second.reason,
        };
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private bearer(): string {
    const now = Date.now();
    if (!this.token || now - this.token.madeAt > TOKEN_LIFETIME_MS)
      this.token = { value: providerToken(this.settings, now), madeAt: now };
    return this.token.value;
  }

  private session(host: keyof typeof HOSTS): ClientHttp2Session {
    const open = this.sessions.get(host);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(HOSTS[host]);
    session.on('error', () => this.sessions.delete(host));
    session.on('close', () => this.sessions.delete(host));
    // Apple keeps a connection open for many sends; an idle one is closed, and the next send opens a new one.
    session.setTimeout(10 * 60 * 1000, () => session.close());
    this.sessions.set(host, session);
    return session;
  }

  private post(
    host: keyof typeof HOSTS,
    deviceToken: string,
    payload: string,
  ): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let request;
      try {
        request = this.session(host).request({
          [constants.HTTP2_HEADER_METHOD]: 'POST',
          [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
          authorization: `bearer ${this.bearer()}`,
          'apns-topic': this.settings.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        });
      } catch (error) {
        resolve({
          ok: false,
          gone: false,
          reason: error instanceof Error ? error.message : 'connect failed',
        });
        return;
      }
      let status = 0;
      let text = '';
      request.setTimeout(15_000, () => request.close(constants.NGHTTP2_CANCEL));
      request.on(
        'response',
        (headers) => (status = Number(headers[constants.HTTP2_HEADER_STATUS])),
      );
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (text += chunk));
      request.on('error', (error) =>
        resolve({ ok: false, gone: false, reason: error.message }),
      );
      request.on('close', () => {
        if (status === 200) return resolve({ ok: true });
        let reason = `HTTP ${status || 'no answer'}`;
        try {
          reason = (JSON.parse(text) as { reason?: string }).reason ?? reason;
        } catch {
          // No body: the status is the reason.
        }
        // 410: the app was removed from the phone, or the token was replaced.
        resolve({ ok: false, gone: status === 410, reason });
      });
      request.end(payload);
    });
  }
}
