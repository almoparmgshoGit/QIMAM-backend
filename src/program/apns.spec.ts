import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APNS_TOKEN, apnsPayload, providerToken } from './apns.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('providerToken', () => {
  it('is an ES256 JWT with the key id and team, signed by the key', () => {
    const token = providerToken(
      { keyId: 'ABC123DEFG', teamId: 'TEAM123456', privateKey: pem },
      1_700_000_000_000,
    );
    const [header, claims, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'ABC123DEFG',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: 'TEAM123456',
      iat: 1_700_000_000,
    });
    const valid = verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    expect(valid).toBe(true);
  });
});

describe('apnsPayload', () => {
  it('puts the data under "body", where the app reads it on a tap', () => {
    const payload = JSON.parse(
      apnsPayload({
        title: 'عنوان',
        body: 'نص',
        data: { notificationId: 'n1', opens: 'ticket', ticketId: 't1' },
      }),
    );
    expect(payload).toEqual({
      aps: { alert: { title: 'عنوان', body: 'نص' }, sound: 'default' },
      body: { notificationId: 'n1', opens: 'ticket', ticketId: 't1' },
    });
  });
});

describe('APNS_TOKEN', () => {
  it('tells an iPhone token from an Expo token', () => {
    expect(APNS_TOKEN.test('a'.repeat(64))).toBe(true);
    expect(APNS_TOKEN.test('ExponentPushToken[abcdefghijklmnop]')).toBe(false);
  });
});
