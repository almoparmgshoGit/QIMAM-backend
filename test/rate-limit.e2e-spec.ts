import { createTestApp, newPhone, type TestApp } from './helpers.js';

describe('rate limits per IP address', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ rateLimits: true });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('stops OTP requests from one address across many numbers', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      const { status } = await t.http().post('/v1/auth/otp/request').send({ phone: newPhone(), purpose: 'login' });
      statuses.push(status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 202)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('stops staff sign-in attempts from one address across many accounts', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      const { status } = await t
        .http()
        .post('/v1/staff/auth/login')
        .set('Origin', 'http://localhost:3000')
        .send({ identifier: `user${attempt}@qimam.test`, password: 'wrong-password-here' });
      statuses.push(status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    const { status, body } = await t
      .http()
      .post('/v1/auth/otp/request')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ phone: newPhone(), purpose: 'login' });
    expect(status).toBe(429);
    expect(body).toMatchObject({ code: 'rate_limited' });
  });
});
