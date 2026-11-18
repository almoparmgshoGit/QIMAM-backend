import { createHash, createPrivateKey, createPublicKey, type KeyObject, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decodeProtectedHeader, type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { ApiError } from '../common/api-error.js';
import { randomId } from '../common/ids.js';
import type { TokenAudience } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

const ALGORITHM = 'ES256';
const ACCESS_TOKEN_TYPE = 'at+jwt';
const ISSUER = 'qimam-api';
const ACCESS_TOKEN_SECONDS = 15 * 60;
const CLOCK_TOLERANCE_SECONDS = 30;
// The verification key comes from the server only. A token that names its own key is an attack.
const FORBIDDEN_HEADERS = ['jwk', 'jku', 'x5u', 'x5c', 'crit', 'zip', 'enc'];

// Each purpose has its own audience, so a token for one is refused everywhere else.
const JWT_AUDIENCE: Record<TokenAudience, string> = { MOBILE: 'qimam-mobile', DASHBOARD: 'qimam-dashboard' };
const REFRESH_TOKEN_MS: Record<TokenAudience, number> = {
  MOBILE: 30 * 24 * 60 * 60 * 1000,
  // Staff sign in again every working day, and using the dashboard does not extend this.
  DASHBOARD: 12 * 60 * 60 * 1000,
};

const REGISTRATION_TOKEN_TYPE = 'registration+jwt';
const REGISTRATION_AUDIENCE = 'qimam-registration';
// Long enough to fill in the sign-up form, read the pledge and choose a track.
const REGISTRATION_TOKEN_SECONDS = 30 * 60;

const MFA_TOKEN_TYPE = 'mfa+jwt';
const MFA_AUDIENCE = 'qimam-mfa';
const MFA_TOKEN_SECONDS = 5 * 60;

const IMPERSONATION_TOKEN_TYPE = 'impersonation+jwt';
const IMPERSONATION_AUDIENCE = 'qimam-impersonation';
// One sitting. It has no refresh: when it ends, the admin opens the account again.
export const IMPERSONATION_TOKEN_SECONDS = 60 * 60;

const IMPERSONATION_TICKET_TYPE = 'impersonation-ticket+jwt';
const IMPERSONATION_TICKET_AUDIENCE = 'qimam-impersonation-ticket';
// Long enough to open a private window and paste the link.
export const IMPERSONATION_TICKET_SECONDS = 3 * 60;

/** An admin signed in as a teacher or supervisor. */
export interface ImpersonationClaims {
  /** The account being used. */
  userId: string;
  /** The admin using it. */
  actorId: string;
  /** The admin's own dashboard session. Ending it ends this too. */
  familyId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly keyId: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const pem = Buffer.from(config.getOrThrow<string>('JWT_PRIVATE_KEY_BASE64'), 'base64').toString();
    this.privateKey = createPrivateKey(pem);
    this.publicKey = createPublicKey(this.privateKey);
    this.keyId = config.getOrThrow<string>('JWT_KEY_ID');
  }

  verifyAccessToken(token: string, audience: TokenAudience = 'MOBILE'): Promise<string> {
    return this.verifySubject(token, JWT_AUDIENCE[audience], ACCESS_TOKEN_TYPE, 'invalid_token');
  }

  /** Proof that the holder received a code on this number. It has its own audience and type, so it opens nothing else. */
  issueRegistrationToken(phone: string): Promise<string> {
    return this.sign(phone, REGISTRATION_AUDIENCE, REGISTRATION_TOKEN_TYPE, REGISTRATION_TOKEN_SECONDS);
  }

  /** Returns the verified phone number. */
  verifyRegistrationToken(token: string): Promise<string> {
    return this.verifySubject(token, REGISTRATION_AUDIENCE, REGISTRATION_TOKEN_TYPE, 'invalid_registration_token');
  }

  /** Proof that the password was right. It only opens the second step of signing in. */
  issueMfaToken(userId: string): Promise<string> {
    return this.sign(userId, MFA_AUDIENCE, MFA_TOKEN_TYPE, MFA_TOKEN_SECONDS);
  }

  verifyMfaToken(token: string): Promise<string> {
    return this.verifySubject(token, MFA_AUDIENCE, MFA_TOKEN_TYPE, 'invalid_mfa_token');
  }

  /**
   * Lets an admin act as a teacher or supervisor in one browser window. It is sent as a bearer header, never a cookie,
   * so it lives only in that window and leaves the admin's own session untouched.
   */
  issueImpersonationToken({ userId, actorId, familyId }: ImpersonationClaims): Promise<string> {
    return this.sign(userId, IMPERSONATION_AUDIENCE, IMPERSONATION_TOKEN_TYPE, IMPERSONATION_TOKEN_SECONDS, {
      act: { sub: actorId },
      fam: familyId,
    });
  }

  async verifyImpersonationToken(token: string): Promise<ImpersonationClaims> {
    const payload = await this.verifyPayload(token, IMPERSONATION_AUDIENCE, IMPERSONATION_TOKEN_TYPE, 'invalid_token');
    const actorId = (payload.act as { sub?: unknown } | undefined)?.sub;
    if (typeof actorId !== 'string' || typeof payload.fam !== 'string') throw new ApiError(401, 'invalid_token');
    return { userId: payload.sub as string, actorId, familyId: payload.fam };
  }

  /**
   * The link an admin pastes into a private window. It only buys the session above, once, within a few minutes, so a
   * copy left in the clipboard or the history is soon worthless.
   */
  issueImpersonationTicket({ userId, actorId, familyId }: ImpersonationClaims): Promise<string> {
    return this.sign(userId, IMPERSONATION_TICKET_AUDIENCE, IMPERSONATION_TICKET_TYPE, IMPERSONATION_TICKET_SECONDS, {
      act: { sub: actorId },
      fam: familyId,
      jti: randomBytes(16).toString('base64url'),
    });
  }

  /** Verifies the link and spends it: a second use is refused. */
  async redeemImpersonationTicket(ticket: string): Promise<ImpersonationClaims> {
    const payload = await this.verifyPayload(ticket, IMPERSONATION_TICKET_AUDIENCE, IMPERSONATION_TICKET_TYPE, 'invalid_ticket');
    const actorId = (payload.act as { sub?: unknown } | undefined)?.sub;
    if (typeof actorId !== 'string' || typeof payload.fam !== 'string' || typeof payload.jti !== 'string') {
      throw new ApiError(401, 'invalid_ticket');
    }
    this.spendTicket(payload.jti, (payload.exp as number) * 1000);
    return { userId: payload.sub as string, actorId, familyId: payload.fam };
  }

  /**
   * Kept in memory: a ticket lives three minutes, so a restart forgets only tickets about to expire. With more than one
   * server instance this needs a shared store.
   */
  private readonly spentTickets = new Map<string, number>();

  private spendTicket(jti: string, expiresAtMs: number): void {
    const now = Date.now();
    for (const [id, expiry] of this.spentTickets) if (expiry + CLOCK_TOLERANCE_SECONDS * 1000 < now) this.spentTickets.delete(id);
    if (this.spentTickets.has(jti)) throw new ApiError(401, 'invalid_ticket');
    this.spentTickets.set(jti, expiresAtMs);
  }

  /** The session family behind a dashboard refresh cookie, while it can still be used. */
  async liveFamilyOf(presentedToken: string): Promise<{ userId: string; familyId: string } | null> {
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presentedToken) },
      select: { userId: true, familyId: true, audience: true, revokedAt: true, replacedById: true, expiresAt: true },
    });
    if (current?.audience !== 'DASHBOARD' || current.revokedAt || current.replacedById || current.expiresAt <= new Date()) {
      return null;
    }
    return { userId: current.userId, familyId: current.familyId };
  }

  /** Whether the session has not been signed out, revoked or expired. */
  async isFamilyLive(familyId: string, userId: string): Promise<boolean> {
    const live = await this.prisma.refreshToken.findFirst({
      where: { familyId, userId, audience: 'DASHBOARD', revokedAt: null, replacedById: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return live !== null;
  }

  /** Starts a new token family, one per signed-in device. */
  async issuePair(userId: string, audience: TokenAudience = 'MOBILE'): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId: randomId(),
        audience,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_MS[audience]),
      },
    });
    return this.buildPair(userId, refreshToken, audience);
  }

  /** Each refresh token works once. Presenting a used one means it leaked, so the whole family ends. */
  async rotate(presentedToken: string, audience: TokenAudience = 'MOBILE'): Promise<TokenPair> {
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presentedToken) },
      include: { user: { select: { role: true, status: true } } },
    });
    if (current?.audience !== audience) throw new ApiError(401, 'invalid_refresh_token');

    if (current.revokedAt || current.replacedById) {
      await this.reportReuse(current.userId, current.familyId);
      throw new ApiError(401, 'invalid_refresh_token');
    }
    const roleFits = (current.user.role === 'STUDENT') === (audience === 'MOBILE');
    if (current.expiresAt <= new Date() || current.user.status !== 'ACTIVE' || !roleFits) {
      throw new ApiError(401, 'invalid_refresh_token');
    }

    const nextToken = randomBytes(32).toString('base64url');
    const rotated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.refreshToken.create({
        data: {
          userId: current.userId,
          familyId: current.familyId,
          audience,
          tokenHash: hashToken(nextToken),
          expiresAt: audience === 'DASHBOARD' ? current.expiresAt : new Date(Date.now() + REFRESH_TOKEN_MS[audience]),
        },
      });
      // The conditions make two simultaneous refreshes race on this row: exactly one can win.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null, replacedById: null },
        data: { replacedById: next.id },
      });
      if (count === 1) return true;
      await tx.refreshToken.delete({ where: { id: next.id } });
      return false;
    });

    if (!rotated) {
      await this.reportReuse(current.userId, current.familyId);
      throw new ApiError(401, 'invalid_refresh_token');
    }
    return this.buildPair(current.userId, nextToken, audience);
  }

  /** Signs out one device. Succeeds silently for an unknown token, so it reveals nothing. */
  async revokeByToken(presentedToken: string): Promise<void> {
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presentedToken) },
      select: { familyId: true },
    });
    if (current) await this.revokeFamily(current.familyId);
  }

  /** Signs a user out everywhere, such as after a password change or suspension. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private async reportReuse(userId: string, familyId: string): Promise<void> {
    await this.revokeFamily(familyId);
    this.logger.warn(`Refresh token reuse: family revoked for user ${userId}`);
    await this.prisma.auditLog.create({
      data: { actorId: userId, action: 'auth.refresh_token_reuse', targetType: 'user', targetId: userId },
    });
  }

  private async verifySubject(token: string, audience: string, type: string, errorCode: string): Promise<string> {
    const payload = await this.verifyPayload(token, audience, type, errorCode);
    return payload.sub as string;
  }

  private async verifyPayload(token: string, audience: string, type: string, errorCode: string): Promise<JWTPayload> {
    try {
      const header = decodeProtectedHeader(token);
      if (FORBIDDEN_HEADERS.some((name) => name in header) || header.kid !== this.keyId) {
        throw new Error('forbidden token header');
      }
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience,
        typ: type,
        requiredClaims: ['sub', 'iss', 'aud', 'iat', 'nbf', 'exp'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      return payload;
    } catch {
      // Every failure looks the same to the client.
      throw new ApiError(401, errorCode);
    }
  }

  private sign(subject: string, audience: string, type: string, seconds: number, claims: JWTPayload = {}): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: ALGORITHM, typ: type, kid: this.keyId })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setNotBefore('0s')
      .setExpirationTime(`${seconds}s`)
      .sign(this.privateKey);
  }

  private async buildPair(userId: string, refreshToken: string, audience: TokenAudience): Promise<TokenPair> {
    const accessToken = await this.sign(userId, JWT_AUDIENCE[audience], ACCESS_TOKEN_TYPE, ACCESS_TOKEN_SECONDS);
    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_SECONDS };
  }
}
