import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import 'dotenv/config';
import { SignJWT, UnsecuredJWT } from 'jose';
import { createTestApp, newPhone, passCooldown, register, REGISTRATION, type TestApp } from './helpers.js';

const WRONG_CODE = '000000';
const signingKey = () => createPrivateKey(Buffer.from(process.env.JWT_PRIVATE_KEY_BASE64 ?? '', 'base64').toString());

describe('auth', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  const me = (token: string) => t.http().get('/v1/me').set('Authorization', `Bearer ${token}`);
  const requestOtp = (phone: string, purpose = 'login') => t.http().post('/v1/auth/otp/request').send({ phone, purpose });
  const verify = (phone: string, code: string) => t.http().post('/v1/auth/otp/verify').send({ phone, code });
  const refresh = (refreshToken: string) => t.http().post('/v1/auth/refresh').send({ refreshToken });

  describe('ids', () => {
    it('are long random strings with no order to them', async () => {
      const first = await register(t);
      const second = await register(t);
      const a = (await me(first.accessToken).expect(200)).body as { id: string };
      const b = (await me(second.accessToken).expect(200)).body as { id: string };

      expect(a.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(b.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(a.id).not.toBe(b.id);
      // Time-ordered ids share a prefix when created close together. These must not.
      expect(a.id.slice(0, 8)).not.toBe(b.id.slice(0, 8));
    });
  });

  describe('registration', () => {
    it('stores the profile, pledges and default notifications', async () => {
      const { accessToken, phone } = await register(t);
      const { body } = await me(accessToken).expect(200);

      expect(body).toMatchObject({
        name: REGISTRATION.fullName,
        phone,
        country: REGISTRATION.country,
        ageBand: '19',
        trackId: 'steady',
        trackStart: null,
        hasCircle: false,
      });
      expect((body as { preferences: { notifications: Record<string, boolean> } }).preferences.notifications).toMatchObject({
        dailyWird: true,
        encouragement: true,
      });
      const user = await t.prisma.user.findUnique({ where: { phone }, include: { consents: true } });
      expect(user?.consents.map((consent) => consent.type).sort()).toEqual([
        'PLAN_PLEDGE',
        'SERIOUSNESS_PLEDGE',
        'TERMS_AND_PRIVACY',
      ]);
    });

    it('stores one account for two spellings of a number', async () => {
      const phone = newPhone();
      await register(t, phone);
      const spaced = `${phone.slice(0, 4)} ${phone.slice(4, 6)} ${phone.slice(6)}`;
      await passCooldown(t, phone);
      await requestOtp(spaced).expect(202);
      await verify(spaced, t.codeFor(phone)).expect(200);
      expect(await t.prisma.user.count({ where: { phone } })).toBe(1);
    });

    it('does not overwrite an existing account', async () => {
      const { phone, accessToken } = await register(t);
      await passCooldown(t, phone);
      await requestOtp(phone, 'register').expect(202);
      await t
        .http()
        .post('/v1/auth/otp/verify')
        .send({ phone, code: t.codeFor(phone), registration: { ...REGISTRATION, fullName: 'اسم آخر مختلف تماما' } })
        .expect(200);
      expect(((await me(accessToken).expect(200)).body as { name: string }).name).toBe(REGISTRATION.fullName);
    });

    it.each([
      ['an unaccepted pledge', { pledgesAccepted: false }],
      ['a two-part name', { fullName: 'نورة محمد' }],
      ['markup in the name', { fullName: '<script>alert(1)</script> a b' }],
      ['a track start on another track', { trackStart: 'kahf' }],
      ['an extra field', { role: 'ADMIN' }],
    ])('rejects %s', async (_name, change) => {
      const phone = newPhone();
      await requestOtp(phone, 'register').expect(202);
      await t
        .http()
        .post('/v1/auth/otp/verify')
        .send({ phone, code: t.codeFor(phone), registration: { ...REGISTRATION, ...change } })
        .expect(400);
      expect(await t.prisma.user.count({ where: { phone } })).toBe(0);
    });
  });

  describe('verifying first, then completing registration', () => {
    const complete = (body: object) => t.http().post('/v1/auth/register').send(body);

    const verifiedToken = async (phone = newPhone()) => {
      await requestOtp(phone).expect(202);
      const { body } = await verify(phone, t.codeFor(phone)).expect(200);
      return { phone, body: body as { registrationToken: string; accessToken?: string } };
    };

    it('gives an unregistered number a registration token and no session', async () => {
      const { phone, body } = await verifiedToken();
      expect(body.registrationToken).toEqual(expect.any(String));
      expect(body.accessToken).toBeUndefined();
      expect(await t.prisma.user.count({ where: { phone } })).toBe(0);
    });

    it('creates the account with the verified number and no second code', async () => {
      const { phone, body } = await verifiedToken();
      const before = t.sent.length;

      const { body: session } = await complete({ registrationToken: body.registrationToken, ...REGISTRATION }).expect(201);

      expect(t.sent.length).toBe(before);
      const { accessToken } = session as { accessToken: string };
      expect((await me(accessToken).expect(200)).body).toMatchObject({ phone, name: REGISTRATION.fullName });
      const user = await t.prisma.user.findUnique({ where: { phone }, include: { consents: true } });
      expect(user?.consents).toHaveLength(3);
    });

    it('rejects a phone number sent next to the token', async () => {
      const { body } = await verifiedToken();
      await complete({ registrationToken: body.registrationToken, ...REGISTRATION, phone: newPhone() }).expect(400);
    });

    it('cannot create a second account or overwrite one', async () => {
      const { phone, body } = await verifiedToken();
      await complete({ registrationToken: body.registrationToken, ...REGISTRATION }).expect(201);

      const { body: error } = await complete({
        registrationToken: body.registrationToken,
        ...REGISTRATION,
        fullName: 'اسم آخر مختلف تماما',
      }).expect(409);

      expect(error).toMatchObject({ code: 'already_registered' });
      expect((await t.prisma.user.findUniqueOrThrow({ where: { phone } })).fullName).toBe(REGISTRATION.fullName);
    });

    it('keeps the token usable after invalid data', async () => {
      const { body } = await verifiedToken();
      await complete({ registrationToken: body.registrationToken, ...REGISTRATION, pledgesAccepted: false }).expect(400);
      await complete({ registrationToken: body.registrationToken, ...REGISTRATION }).expect(201);
    });

    it('does not accept the registration token as an access token', async () => {
      const { body } = await verifiedToken();
      await me(body.registrationToken).expect(401);
    });

    it('does not accept an access token as a registration token', async () => {
      const { accessToken } = await register(t);
      await complete({ registrationToken: accessToken, ...REGISTRATION }).expect(401);
    });

    it.each([
      ['expired', (jwt: SignJWT) => jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 120)],
      ['for another audience', (jwt: SignJWT) => jwt.setAudience('qimam-mobile')],
    ])('rejects a registration token that is %s', async (_name, change) => {
      const jwt = new SignJWT()
        .setProtectedHeader({ alg: 'ES256', typ: 'registration+jwt', kid: process.env.JWT_KEY_ID })
        .setSubject(newPhone())
        .setIssuer('qimam-api')
        .setAudience('qimam-registration')
        .setIssuedAt()
        .setNotBefore('0s')
        .setExpirationTime('5m');
      await complete({ registrationToken: await change(jwt).sign(signingKey()), ...REGISTRATION }).expect(401);
    });

    it('rejects a registration token signed with another key', async () => {
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const token = await new SignJWT()
        .setProtectedHeader({ alg: 'ES256', typ: 'registration+jwt', kid: process.env.JWT_KEY_ID })
        .setSubject(newPhone())
        .setIssuer('qimam-api')
        .setAudience('qimam-registration')
        .setIssuedAt()
        .setNotBefore('0s')
        .setExpirationTime('5m')
        .sign(privateKey);
      await complete({ registrationToken: token, ...REGISTRATION }).expect(401);
    });
  });

  describe('one-time codes', () => {
    it('treats numbers with and without an account the same until the code is proven', async () => {
      const { phone: known } = await register(t);
      await passCooldown(t, known);
      const unknown = newPhone();
      const before = t.sent.length;

      const a = await requestOtp(known).expect(202);
      const b = await requestOtp(unknown).expect(202);

      expect(a.body).toEqual(b.body);
      expect(t.sent.length).toBe(before + 2);
      // Both now have an identical failure.
      const c = await verify(known, WRONG_CODE).expect(401);
      const d = await verify(unknown, WRONG_CODE).expect(401);
      expect((c.body as { code: string }).code).toBe((d.body as { code: string }).code);
    });

    it('stores only a hash of the code', async () => {
      const phone = newPhone();
      await requestOtp(phone, 'register').expect(202);
      const code = t.codeFor(phone);
      const row = await t.prisma.otpChallenge.findFirstOrThrow({ where: { phone } });
      expect(JSON.stringify(row)).not.toContain(code);
    });

    it('stops accepting guesses after 5 tries, even the right code', async () => {
      const phone = newPhone();
      await requestOtp(phone, 'register').expect(202);
      for (let attempt = 0; attempt < 5; attempt++) await verify(phone, WRONG_CODE).expect(401);
      await t
        .http()
        .post('/v1/auth/otp/verify')
        .send({ phone, code: t.codeFor(phone), registration: REGISTRATION })
        .expect(401);
    });

    it('counts simultaneous guesses', async () => {
      const phone = newPhone();
      await requestOtp(phone, 'register').expect(202);
      await Promise.all(Array.from({ length: 12 }, () => verify(phone, WRONG_CODE)));
      const row = await t.prisma.otpChallenge.findFirstOrThrow({ where: { phone } });
      expect(row.attempts).toBe(5);
    });

    it('works once', async () => {
      const { phone } = await register(t);
      await verify(phone, t.codeFor(phone)).expect(401);
    });

    it('signs in once when two requests carry the same code', async () => {
      const { phone } = await register(t);
      await passCooldown(t, phone);
      await requestOtp(phone).expect(202);
      const code = t.codeFor(phone);
      const results = await Promise.all([verify(phone, code), verify(phone, code)]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    });

    it('rejects an expired code', async () => {
      const { phone } = await register(t);
      await passCooldown(t, phone);
      await requestOtp(phone).expect(202);
      await t.prisma.otpChallenge.updateMany({ where: { phone }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await verify(phone, t.codeFor(phone)).expect(401);
    });

    it('invalidates the previous code when a new one is sent', async () => {
      const { phone } = await register(t);
      await passCooldown(t, phone);
      await requestOtp(phone).expect(202);
      const first = t.codeFor(phone);
      await passCooldown(t, phone);
      await requestOtp(phone).expect(202);
      const second = t.codeFor(phone);
      if (first !== second) await verify(phone, first).expect(401);
      await verify(phone, second).expect(200);
    });

    it('enforces the resend cooldown, also for simultaneous requests', async () => {
      const phone = newPhone();
      const results = await Promise.all(Array.from({ length: 6 }, () => requestOtp(phone, 'register')));
      expect(results.filter((result) => result.status === 202)).toHaveLength(1);
      const limited = results.find((result) => result.status === 429);
      expect(limited?.body).toMatchObject({ code: 'otp_cooldown' });
      expect((limited?.body as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
      expect(t.sent.filter((item) => item.phone === phone)).toHaveLength(1);
    });

    it('limits a number to 5 codes an hour', async () => {
      const phone = newPhone();
      for (let sent = 0; sent < 5; sent++) {
        await requestOtp(phone, 'register').expect(202);
        await t.prisma.otpChallenge.updateMany({
          where: { phone, createdAt: { gte: new Date(Date.now() - 30_000) } },
          data: { createdAt: new Date(Date.now() - 2 * 60 * 1000) },
        });
      }
      const { body } = await requestOtp(phone, 'register').expect(429);
      expect(body).toMatchObject({ code: 'otp_hourly_limit' });
    });
  });

  describe('access tokens', () => {
    const signedBy = (key: Parameters<SignJWT['sign']>[0], sub: string, header = {}) =>
      new SignJWT()
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: process.env.JWT_KEY_ID, ...header })
        .setSubject(sub)
        .setIssuer('qimam-api')
        .setAudience('qimam-mobile')
        .setIssuedAt()
        .setNotBefore('0s')
        .setExpirationTime('5m')
        .sign(key);

    let userId: string;

    beforeAll(async () => {
      const { accessToken } = await register(t);
      userId = ((await me(accessToken).expect(200)).body as { id: string }).id;
    });

    it('accepts a token built the same way as the server builds them (guards the cases below)', async () => {
      await me(await signedBy(signingKey(), userId)).expect(200);
    });

    it('rejects a missing token', async () => {
      await t.http().get('/v1/me').expect(401);
    });

    it('rejects alg none', async () => {
      const token = new UnsecuredJWT({}).setSubject(userId).setIssuer('qimam-api').setAudience('qimam-mobile').setExpirationTime('5m').encode();
      await me(token).expect(401);
    });

    it('rejects HS256 signed with the public key (algorithm confusion)', async () => {
      const publicPem = createPublicKey(signingKey()).export({ type: 'spki', format: 'pem' });
      const token = await new SignJWT()
        .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: process.env.JWT_KEY_ID })
        .setSubject(userId)
        .setIssuer('qimam-api')
        .setAudience('qimam-mobile')
        .setIssuedAt()
        .setNotBefore('0s')
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(publicPem as string));
      await me(token).expect(401);
    });

    it('rejects a token signed with another key', async () => {
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      await me(await signedBy(privateKey, userId)).expect(401);
    });

    it('rejects a token that embeds its own key (JWK injection)', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      await me(await signedBy(privateKey, userId, { jwk })).expect(401);
    });

    it.each([
      ['jku', { jku: 'https://attacker.example/keys' }],
      ['x5u', { x5u: 'https://attacker.example/cert' }],
      ['an unknown kid', { kid: '../../etc/passwd' }],
      ['the wrong typ', { typ: 'JWT' }],
    ])('rejects a validly signed token with %s', async (_name, header) => {
      await me(await signedBy(signingKey(), userId, header)).expect(401);
    });

    it('rejects a tampered payload', async () => {
      const [header, , signature] = (await signedBy(signingKey(), userId)).split('.');
      const payload = Buffer.from(JSON.stringify({ sub: userId, role: 'ADMIN', exp: 9_999_999_999 })).toString('base64url');
      await me(`${header}.${payload}.${signature}`).expect(401);
    });

    it.each([
      ['expired', (jwt: SignJWT) => jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 120)],
      ['not yet valid', (jwt: SignJWT) => jwt.setNotBefore(Math.floor(Date.now() / 1000) + 300)],
      ['from another issuer', (jwt: SignJWT) => jwt.setIssuer('someone-else')],
      ['for another audience', (jwt: SignJWT) => jwt.setAudience('qimam-dashboard')],
    ])('rejects a token that is %s', async (_name, change) => {
      const jwt = new SignJWT()
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: process.env.JWT_KEY_ID })
        .setSubject(userId)
        .setIssuer('qimam-api')
        .setAudience('qimam-mobile')
        .setIssuedAt()
        .setNotBefore('0s')
        .setExpirationTime('5m');
      await me(await change(jwt).sign(signingKey())).expect(401);
    });

    it('stops working as soon as the account is suspended', async () => {
      const { accessToken, refreshToken, phone } = await register(t);
      await me(accessToken).expect(200);
      await t.prisma.user.update({ where: { phone }, data: { status: 'SUSPENDED' } });
      await me(accessToken).expect(401);
      await refresh(refreshToken).expect(401);
      await passCooldown(t, phone);
      await requestOtp(phone).expect(202);
      await verify(phone, t.codeFor(phone)).expect(403);
    });
  });

  describe('refresh tokens', () => {
    it('rotates, and stores only a hash', async () => {
      const { refreshToken, phone } = await register(t);
      const { body } = await refresh(refreshToken).expect(200);
      const next = body as { accessToken: string; refreshToken: string };
      expect(next.refreshToken).not.toBe(refreshToken);
      await me(next.accessToken).expect(200);

      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone }, include: { refreshTokens: true } });
      expect(JSON.stringify(user.refreshTokens)).not.toContain(refreshToken);
    });

    it('ends the whole family when a used token comes back', async () => {
      const { refreshToken, phone } = await register(t);
      const next = (await refresh(refreshToken).expect(200)).body as { refreshToken: string };

      await refresh(refreshToken).expect(401);
      await refresh(next.refreshToken).expect(401);

      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone } });
      expect(await t.prisma.auditLog.count({ where: { actorId: user.id, action: 'auth.refresh_token_reuse' } })).toBeGreaterThan(0);
    });

    it('lets one of two simultaneous refreshes through', async () => {
      const { refreshToken } = await register(t);
      const results = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);
      expect(results.filter((result) => result.status === 200).length).toBeLessThanOrEqual(1);
      expect(results.some((result) => result.status === 401)).toBe(true);
    });

    it('does not touch another device', async () => {
      const { phone, refreshToken: first } = await register(t);
      await passCooldown(t, phone);
      await requestOtp(phone).expect(202);
      const second = (await verify(phone, t.codeFor(phone)).expect(200)).body as { refreshToken: string };

      await t.http().post('/v1/auth/logout').send({ refreshToken: first }).expect(204);
      await refresh(first).expect(401);
      await refresh(second.refreshToken).expect(200);
    });

    it('rejects an expired token', async () => {
      const { refreshToken, phone } = await register(t);
      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone } });
      await t.prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await refresh(refreshToken).expect(401);
    });

    it('answers logout the same for an unknown token', async () => {
      await t.http().post('/v1/auth/logout').send({ refreshToken: 'a'.repeat(43) }).expect(204);
    });
  });

  describe('profile', () => {
    const patch = (token: string, body: object) => t.http().patch('/v1/me').set('Authorization', `Bearer ${token}`).send(body);

    it('saves track and preferences', async () => {
      const { accessToken } = await register(t);
      const { body } = await patch(accessToken, {
        track: { trackId: 'stabilization', trackStart: 'fatiha' },
        preferences: { language: 'en', notifications: { encouragement: true } },
      }).expect(200);
      expect(body).toMatchObject({
        trackId: 'stabilization',
        trackStart: 'fatiha',
        preferences: { language: 'en', notifications: { encouragement: true, dailyWird: true } },
      });
    });

    it.each([
      ['role', { role: 'ADMIN' }],
      ['status', { status: 'ACTIVE' }],
      ['phone', { phone: '+966501234567' }],
      ['id', { id: 'x' }],
      ['__proto__', JSON.parse('{"__proto__": {"role": "ADMIN"}}') as object],
    ])('rejects a change to %s (mass assignment)', async (_name, body) => {
      const { accessToken, phone } = await register(t);
      await patch(accessToken, body).expect(400);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { phone } })).role).toBe('STUDENT');
    });

    it('exposes only the listed fields', async () => {
      const { accessToken } = await register(t);
      const { body } = await me(accessToken).expect(200);
      expect(Object.keys(body as object).sort()).toEqual(
        ['admission', 'ageBand', 'country', 'hasCircle', 'id', 'name', 'phone', 'preferences', 'trackId', 'trackStart'].sort(),
      );
    });
  });

  describe('deleting an account', () => {
    it('removes the data and every token, and keeps only an anonymous audit row', async () => {
      const { accessToken, refreshToken, phone } = await register(t);
      const id = ((await me(accessToken).expect(200)).body as { id: string }).id;

      await t.http().delete('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(204);

      await me(accessToken).expect(401);
      await refresh(refreshToken).expect(401);
      expect(await t.prisma.user.count({ where: { phone } })).toBe(0);
      expect(await t.prisma.userConsent.count({ where: { userId: id } })).toBe(0);
      expect(await t.prisma.refreshToken.count({ where: { userId: id } })).toBe(0);
      expect(await t.prisma.otpChallenge.count({ where: { phone } })).toBe(0);

      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { actorId: id, action: 'user.delete_account' } });
      expect(JSON.stringify(audit)).not.toContain(phone);
    });
  });

  describe('audit log', () => {
    it('cannot be changed or erased, even by the database owner', async () => {
      await register(t);
      const row = await t.prisma.auditLog.findFirstOrThrow();
      await expect(t.prisma.auditLog.update({ where: { id: row.id }, data: { action: 'edited' } })).rejects.toThrow();
      await expect(t.prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow();
    });
  });

  describe('HTTP hardening', () => {
    it('sets security headers and forbids caching', async () => {
      const { headers } = await t.http().get('/v1/health').expect(200);
      expect(headers['strict-transport-security']).toBeDefined();
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBeDefined();
      expect(headers['content-security-policy']).toBeDefined();
      expect(headers['cache-control']).toBe('no-store');
      expect(headers['x-powered-by']).toBeUndefined();
    });

    it('does not take a request id from the client', async () => {
      const { headers } = await t.http().get('/v1/health').set('X-Request-Id', 'injected');
      expect(headers['x-request-id']).not.toBe('injected');
    });

    it('rejects a body over the limit', async () => {
      const { body } = await requestOtp('a'.repeat(200_000)).expect(413);
      expect(body).toMatchObject({ code: 'payload_too_large' });
    });

    it('rejects malformed JSON without leaking details', async () => {
      const { body, text } = await t
        .http()
        .post('/v1/auth/otp/request')
        .set('Content-Type', 'application/json')
        .send('{"phone":')
        .expect(400);
      expect(body).toMatchObject({ statusCode: 400, code: 'validation_failed' });
      expect(text).not.toMatch(/stack|node_modules|SyntaxError|\.ts:/);
    });

    it.each([
      ['form data', 'application/x-www-form-urlencoded', 'phone=%2B966501234567&purpose=login'],
      ['text', 'text/plain', '{"phone":"+966501234567","purpose":"login"}'],
    ])('rejects %s', async (_name, type, payload) => {
      await t.http().post('/v1/auth/otp/request').set('Content-Type', type).send(payload).expect(400);
    });

    it('rejects a duplicated parameter (parameter pollution)', async () => {
      await t.http().post('/v1/auth/otp/request').send({ phone: [newPhone(), newPhone()], purpose: 'login' }).expect(400);
    });

    it.each([
      ['an invalid number', { phone: '123', purpose: 'login' }],
      ['SQL in the number', { phone: "' OR 1=1 --", purpose: 'login' }],
      ['an object as the number', { phone: { $gt: '' }, purpose: 'login' }],
      ['an unknown purpose', { phone: '+966501234567', purpose: 'admin' }],
      ['an extra field', { phone: '+966501234567', purpose: 'login', extra: 1 }],
    ])('rejects %s', async (_name, body) => {
      await t.http().post('/v1/auth/otp/request').send(body).expect(400);
    });

    it('rejects a code in the wrong shape', async () => {
      await verify(newPhone(), '12a456').expect(400);
      await verify(newPhone(), '1234').expect(400);
    });

    it('does not expose unknown routes or methods', async () => {
      await t.http().get('/').expect(404);
      await t.http().put('/v1/me').expect(404);
      await t.http().get('/v1/docs').expect(404);
    });
  });
});
