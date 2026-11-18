import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticaOtpDelivery } from './otp-delivery.js';

const PHONE = '+966551234567';

function delivery(settings: Record<string, unknown> = {}) {
  return new AuthenticaOtpDelivery(new ConfigService({ AUTHENTICA_API_KEY: 'test-key-123456', ...settings }));
}

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('AuthenticaOtpDelivery', () => {
  it('sends with the key, method and template', async () => {
    const fetchMock = answer(200, { success: true, data: null, message: 'OTP send successfully' });
    await delivery({ AUTHENTICA_METHOD: 'whatsapp', AUTHENTICA_TEMPLATE_ID: 31 }).deliver(PHONE);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.authentica.sa/api/v2/send-otp');
    expect((init.headers as Record<string, string>)['X-Authorization']).toBe('test-key-123456');
    expect(JSON.parse(init.body as string)).toEqual({ method: 'whatsapp', phone: PHONE, template_id: 31 });
    expect(init.redirect).toBe('manual');
  });

  it('throws when the send is refused, without the number in the message', async () => {
    answer(401, { message: 'Unauthorized' });
    await expect(delivery().deliver(PHONE)).rejects.toThrow(/HTTP 401.*Unauthorized/);
    await expect(delivery().deliver(PHONE)).rejects.not.toThrow(new RegExp(PHONE.slice(1)));
  });

  it('accepts a verified code', async () => {
    answer(200, { status: true, message: 'OTP verified successfully' });
    await expect(delivery().check(PHONE, '012345')).resolves.toBe(true);
  });

  it('rejects a wrong code given as status: false', async () => {
    answer(200, { status: false, message: 'Invalid OTP' });
    await expect(delivery().check(PHONE, '000000')).resolves.toBe(false);
  });

  it('rejects a wrong code given as HTTP 422', async () => {
    answer(422, { message: 'The otp is invalid' });
    await expect(delivery().check(PHONE, '000000')).resolves.toBe(false);
  });

  it('throws when Authentica cannot answer', async () => {
    answer(500, { message: 'Server error' });
    await expect(delivery().check(PHONE, '000000')).rejects.toThrow(/HTTP 500/);
  });
});
