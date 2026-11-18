import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * How a code reaches the student. Some providers send a code this server made; others make the code
 * themselves and check it on request. Either way, OtpService keeps the limits, the attempt count and single use.
 */
export abstract class OtpDelivery {
  /** True when the provider makes the code, so `deliver` gets none and `check` decides whether it is right. */
  readonly providerIssuesCodes: boolean = false;

  /** `code` is null when the provider makes its own. */
  abstract deliver(phone: string, code: string | null): Promise<void>;

  /** Called only when the provider makes the codes. Throws when the provider cannot answer. */
  check(_phone: string, _code: string): Promise<boolean> {
    return Promise.reject(new Error('this delivery does not check codes'));
  }
}

/**
 * Development stand-in: prints the code to the backend's console.
 * validateEnv refuses it in production, where anyone reading the logs could sign in as anyone.
 */
@Injectable()
export class ConsoleOtpDelivery extends OtpDelivery {
  private readonly logger = new Logger('OTP');

  deliver(phone: string, code: string | null): Promise<void> {
    this.logger.log(`${phone} code: ${code}`);
    return Promise.resolve();
  }
}

const AUTHENTICA_BASE_URL = 'https://api.authentica.sa/api/v2';
const AUTHENTICA_TIMEOUT_MS = 10_000;

/**
 * Authentica (https://docs.authentica.sa) sends the code by SMS or WhatsApp and checks it itself.
 * The code's length, wording and sender name come from the application's settings in the Authentica portal.
 */
@Injectable()
export class AuthenticaOtpDelivery extends OtpDelivery {
  override readonly providerIssuesCodes = true;
  private readonly apiKey: string;
  private readonly method: 'sms' | 'whatsapp';
  private readonly templateId: number | undefined;

  constructor(config: ConfigService) {
    super();
    this.apiKey = config.getOrThrow<string>('AUTHENTICA_API_KEY');
    this.method = config.get<'sms' | 'whatsapp'>('AUTHENTICA_METHOD') ?? 'sms';
    this.templateId = config.get<number>('AUTHENTICA_TEMPLATE_ID');
  }

  async deliver(phone: string): Promise<void> {
    const { status, body } = await this.post('/send-otp', { method: this.method, phone, template_id: this.templateId });
    if (status < 200 || status >= 300 || body.success !== true) {
      throw new Error(`Authentica refused the send (HTTP ${status}): ${describe(body)}`);
    }
  }

  async check(phone: string, code: string): Promise<boolean> {
    const { status, body } = await this.post('/verify-otp', { phone, otp: code });
    // A wrong or expired code comes back either as status: false or as HTTP 422.
    if (status === 422) return false;
    if (status < 200 || status >= 300) throw new Error(`Authentica could not check the code (HTTP ${status}): ${describe(body)}`);
    return body.status === true;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${AUTHENTICA_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Authorization': this.apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(AUTHENTICA_TIMEOUT_MS),
      // The key must never follow a redirect to another host.
      redirect: 'manual',
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch {
      // Not JSON: the status alone decides.
    }
    return { status: response.status, body };
  }
}

/** The provider's message only, never the request, so no phone number or code reaches the log. */
function describe(body: Record<string, unknown>): string {
  // Errors come as { errors: [{ message }] }, other answers as { message }.
  const errors = Array.isArray(body.errors) ? (body.errors as unknown[]) : [];
  const messages = errors
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).message : undefined))
    .filter((message): message is string => typeof message === 'string');
  if (typeof body.message === 'string') messages.unshift(body.message);
  return messages.length > 0 ? messages.join('; ').slice(0, 200) : 'no message';
}
