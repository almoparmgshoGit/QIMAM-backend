import type { CookieOptions, Response } from 'express';
import type { TokenPair } from './tokens.service.js';

export const STAFF_ACCESS_COOKIE = 'qimam_staff_at';
export const STAFF_REFRESH_COOKIE = 'qimam_staff_rt';

const REFRESH_PATH = '/v1/staff/auth';
const REFRESH_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Page scripts can't read these, so an XSS in the dashboard can't steal the session. */
const baseOptions = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
});

export function setStaffCookies(response: Response, tokens: TokenPair): void {
  response.cookie(STAFF_ACCESS_COOKIE, tokens.accessToken, { ...baseOptions(), path: '/', maxAge: tokens.expiresIn * 1000 });
  // Sent only to the auth routes, so everyday requests don't carry the longer-lived token.
  response.cookie(STAFF_REFRESH_COOKIE, tokens.refreshToken, { ...baseOptions(), path: REFRESH_PATH, maxAge: REFRESH_MAX_AGE_MS });
}

export function clearStaffCookies(response: Response): void {
  response.clearCookie(STAFF_ACCESS_COOKIE, { ...baseOptions(), path: '/' });
  response.clearCookie(STAFF_REFRESH_COOKIE, { ...baseOptions(), path: REFRESH_PATH });
}
