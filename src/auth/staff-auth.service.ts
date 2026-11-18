import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { ApiError } from '../common/api-error.js';
import { forSection } from '../common/sections.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';
import { PERMISSIONS } from './permissions.js';
import { StaffMailer } from './staff-mailer.js';
import type {
  ChangePasswordDto,
  MfaCodeDto,
  SetPasswordDto,
  StaffLoginDto,
} from './staff-auth.schemas.js';
import type { StaffActor } from './staff.decorators.js';
import { IMPERSONATION_TICKET_SECONDS, IMPERSONATION_TOKEN_SECONDS, type TokenPair, TokensService } from './tokens.service.js';
import { TotpService } from './totp.service.js';

const MAX_FAILURES = 5;
const BASE_LOCK_MS = 15 * 60 * 1000;
const MAX_LOCK_MS = 24 * 60 * 60 * 1000;
const SETUP_TOKEN_MS = 72 * 60 * 60 * 1000;
const RECOVERY_TOKEN_MS = 60 * 60 * 1000;
const SETUP_PURPOSE = 'SET_PASSWORD';

export type LoginResult =
  | { next: 'done'; tokens: TokenPair }
  | { next: 'totp' | 'enroll_totp'; mfaToken: string };

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

@Injectable()
export class StaffAuthService {
  private readonly logger = new Logger(StaffAuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly mailer: StaffMailer,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokensService,
    private readonly totp: TotpService,
    private readonly auditLog: AuditService,
  ) {}

  /** A wrong email, wrong password, suspended account and locked account all answer the same. */
  async login({ identifier, password }: StaffLoginDto): Promise<LoginResult> {
    const invalid = new ApiError(401, 'invalid_credentials');
    const user = await this.prisma.user.findFirst({
      where: { ...this.identifierFilter(identifier), role: { not: 'STUDENT' } },
      include: { staffCredential: true },
    });
    const credential = user?.staffCredential;

    const passwordOk = await this.passwords.verify(credential?.passwordHash, password);
    if (!user || !credential?.passwordHash) throw invalid;
    if (credential.lockedUntil && credential.lockedUntil > new Date()) throw invalid;
    if (!passwordOk) {
      await this.recordFailure(user.id);
      throw invalid;
    }
    if (user.status !== 'ACTIVE') throw invalid;

    if (credential.totpEnabledAt) return { next: 'totp', mfaToken: await this.tokens.issueMfaToken(user.id) };
    // Teachers may add it later. Supervisors and administrators cannot sign in without it.
    if (user.role !== 'TEACHER') return { next: 'enroll_totp', mfaToken: await this.tokens.issueMfaToken(user.id) };

    return { next: 'done', tokens: await this.completeSignIn(user.id) };
  }

  async verifyTotp({ mfaToken, code }: MfaCodeDto): Promise<TokenPair> {
    const { userId, credential } = await this.mfaSubject(mfaToken);
    if (!credential.totpEnabledAt || !credential.totpSecretEncrypted) throw new ApiError(401, 'invalid_mfa_token');
    await this.acceptCode(userId, credential.totpSecretEncrypted, code, credential.totpLastStep);
    return this.completeSignIn(userId);
  }

  /**
   * Only for an account with no confirmed authenticator. Otherwise a stolen password could replace it,
   * which would defeat the second factor.
   */
  async startEnrollment(mfaToken: string): Promise<{ secret: string; otpauthUri: string }> {
    const { userId, credential, label } = await this.mfaSubject(mfaToken);
    if (credential.totpEnabledAt) throw new ApiError(409, 'totp_already_enabled');

    const { secret, otpauthUri, encrypted } = this.totp.createEnrollment(label);
    await this.prisma.staffCredential.update({
      where: { userId },
      data: { totpSecretEncrypted: encrypted, totpLastStep: null },
    });
    return { secret, otpauthUri };
  }

  async confirmEnrollment({ mfaToken, code }: MfaCodeDto): Promise<TokenPair> {
    const { userId, credential } = await this.mfaSubject(mfaToken);
    if (credential.totpEnabledAt || !credential.totpSecretEncrypted) throw new ApiError(409, 'totp_already_enabled');

    await this.acceptCode(userId, credential.totpSecretEncrypted, code, credential.totpLastStep);
    await this.prisma.staffCredential.update({ where: { userId }, data: { totpEnabledAt: new Date() } });
    await this.audit(userId, 'staff.totp_enabled');
    return this.completeSignIn(userId);
  }

  /** Creates a single-use link token. Any earlier link for this person stops working. */
  async issueSetupToken(userId: string, lifetimeMs = SETUP_TOKEN_MS): Promise<{ setupToken: string; expiresAt: Date }> {
    const setupToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + lifetimeMs);
    await this.prisma.$transaction([
      this.prisma.staffSecurityToken.updateMany({
        where: { userId, purpose: SETUP_PURPOSE, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      this.prisma.staffSecurityToken.create({
        data: { userId, purpose: SETUP_PURPOSE, tokenHash: hashToken(setupToken), expiresAt },
      }),
    ]);
    return { setupToken, expiresAt };
  }

  /**
   * Answers the same whether or not the account exists, and doesn't wait for the mail, so neither the reply
   * nor its timing reveals who has an account. The authenticator stays in place: a new password alone doesn't sign in.
   */
  requestPasswordRecovery(email: string): void {
    void this.sendRecoveryLink(email.toLowerCase()).catch((error: unknown) => {
      this.logger.error(`recovery mail failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  }

  private async sendRecoveryLink(email: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { email, role: { not: 'STUDENT' }, status: 'ACTIVE' },
      select: { id: true, fullName: true, email: true, section: true },
    });
    if (!user?.email) return;
    const say = (text: string) => forSection(text, user.section);

    const { setupToken } = await this.issueSetupToken(user.id, RECOVERY_TOKEN_MS);
    const origin = this.config.getOrThrow<string[]>('ADMIN_ORIGINS')[0];
    await this.audit(user.id, 'staff.password_recovery_requested');
    await this.mailer.send({
      to: user.email,
      subject: 'استعادة كلمة المرور - برنامج قمم',
      text: [
        `مرحبًا ${user.fullName}،`,
        say('لتعيين كلمة مرور جديدة {{افتح|افتحي}} الرابط التالي خلال ساعة:'),
        `${origin}/set-password?token=${encodeURIComponent(setupToken)}`,
        say('إن لم {{تطلب|تطلبي}} ذلك {{فتجاهل|فتجاهلي}} هذه الرسالة، وستبقى كلمة مرورك كما هي.'),
      ].join('\n\n'),
    });
  }

  async setPassword({ token, password }: SetPasswordDto): Promise<void> {
    const invalid = new ApiError(400, 'invalid_setup_token');
    const record = await this.prisma.staffSecurityToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { id: true, email: true, fullName: true } } },
    });
    if (!record || record.consumedAt || record.expiresAt <= new Date() || record.purpose !== SETUP_PURPOSE) throw invalid;

    // Checked before the token is spent, so a rejected password doesn't burn the link.
    await this.passwords.assertAcceptable(password, record.user);
    const passwordHash = await this.passwords.hash(password);

    const consumed = await this.prisma.staffSecurityToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid;

    await this.prisma.staffCredential.update({
      where: { userId: record.userId },
      data: { passwordHash, passwordChangedAt: new Date(), failedAttempts: 0, lockedUntil: null },
    });
    await this.tokens.revokeAllForUser(record.userId);
    await this.audit(record.userId, 'staff.password_set');
  }

  /**
   * An admin opens a teacher's or supervisor's dashboard in a private window: this gives the one-time link to paste
   * there. The account's password and second step are not needed, since the admin passed their own. It is tied to the
   * admin's session and recorded.
   */
  async impersonate(admin: StaffActor, targetId: string, refreshToken: string | undefined) {
    const session = refreshToken ? await this.tokens.liveFamilyOf(refreshToken) : null;
    if (session?.userId !== admin.id) throw new ApiError(401, 'invalid_token');

    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: { role: true, status: true } });
    if (target?.role !== 'TEACHER' && target?.role !== 'SUPERVISOR') throw new ApiError(404, 'not_found');
    if (target.status !== 'ACTIVE') throw new ApiError(409, 'account_suspended');

    const ticket = await this.tokens.issueImpersonationTicket({ userId: targetId, actorId: admin.id, familyId: session.familyId });
    await this.auditLog.record(admin, 'staff.impersonate', { type: 'user', id: targetId }, { role: target.role });
    return { ticket, expiresAt: new Date(Date.now() + IMPERSONATION_TICKET_SECONDS * 1000).toISOString() };
  }

  /** Run in the private window: spends the link and starts the session, checking both accounts again. */
  async redeemImpersonation(ticket: string) {
    const claims = await this.tokens.redeemImpersonationTicket(ticket);
    const [target, admin, sessionLive] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: claims.userId }, select: { role: true, status: true } }),
      this.prisma.user.findUnique({ where: { id: claims.actorId }, select: { role: true, status: true } }),
      this.tokens.isFamilyLive(claims.familyId, claims.actorId),
    ]);
    const targetFits = target?.status === 'ACTIVE' && (target.role === 'TEACHER' || target.role === 'SUPERVISOR');
    if (!targetFits || admin?.status !== 'ACTIVE' || admin.role !== 'ADMIN' || !sessionLive) throw new ApiError(401, 'invalid_ticket');

    const token = await this.tokens.issueImpersonationToken(claims);
    return { token, expiresAt: new Date(Date.now() + IMPERSONATION_TOKEN_SECONDS * 1000).toISOString() };
  }

  /** The admin behind an impersonated session, shown in that window so it is never mistaken for the account's own. */
  async impersonator(adminId: string) {
    const admin = await this.prisma.user.findUnique({ where: { id: adminId }, select: { id: true, fullName: true } });
    return admin ? { id: admin.id, name: admin.fullName } : null;
  }

  async changePassword(userId: string, { currentPassword, newPassword }: ChangePasswordDto): Promise<TokenPair> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { staffCredential: true } });
    const credential = user.staffCredential;
    if (!(await this.passwords.verify(credential?.passwordHash, currentPassword)) || !credential?.passwordHash) {
      await this.recordFailure(userId);
      throw new ApiError(400, 'invalid_current_password');
    }
    await this.passwords.assertAcceptable(newPassword, user);

    await this.prisma.staffCredential.update({
      where: { userId },
      data: { passwordHash: await this.passwords.hash(newPassword), passwordChangedAt: new Date() },
    });
    // Every other device signs out. This one gets a new session.
    await this.tokens.revokeAllForUser(userId);
    await this.audit(userId, 'staff.password_changed');
    return this.tokens.issuePair(userId, 'DASHBOARD');
  }

  async profile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        section: true,
        scope: { select: { id: true, name: true } },
        taughtCircles: { where: { archivedAt: null }, select: { id: true, name: true } },
        staffCredential: { select: { totpEnabledAt: true } },
        rank: { select: { id: true, name: true, permissions: true } },
      },
    });
    return {
      id: user.id,
      name: user.fullName,
      email: user.email,
      role: user.role,
      section: user.section,
      scope: user.scope,
      circles: user.taughtCircles,
      totpEnabled: Boolean(user.staffCredential?.totpEnabledAt),
      // The dashboard shows an employee only the sections their rank opens. The API checks each request itself.
      rank: user.rank
        ? { id: user.rank.id, name: user.rank.name, permissions: user.rank.permissions.filter((key) => Object.hasOwn(PERMISSIONS, key)) }
        : null,
    };
  }

  private identifierFilter(identifier: string) {
    if (identifier.includes('@')) return { email: identifier.toLowerCase() };
    const phone = parsePhoneNumberFromString(identifier);
    return { phone: phone?.isValid() ? phone.number : identifier };
  }

  private async mfaSubject(mfaToken: string) {
    const invalid = new ApiError(401, 'invalid_mfa_token');
    const userId = await this.tokens.verifyMfaToken(mfaToken);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { staffCredential: true } });
    const credential = user?.staffCredential;
    if (!user || !credential || user.status !== 'ACTIVE' || user.role === 'STUDENT') throw invalid;
    if (credential.lockedUntil && credential.lockedUntil > new Date()) throw invalid;
    return { userId, credential, label: user.email ?? user.phone ?? user.id };
  }

  private async acceptCode(userId: string, encrypted: string, code: string, lastStep: number | null): Promise<void> {
    const invalid = new ApiError(401, 'invalid_totp_code');
    const step = await this.totp.check(encrypted, code, lastStep);
    if (step === null) {
      await this.recordFailure(userId);
      throw invalid;
    }
    // A code signs in once, even if two requests carry it at the same moment.
    const accepted = await this.prisma.staffCredential.updateMany({
      where: { userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    if (accepted.count !== 1) throw invalid;
  }

  private async completeSignIn(userId: string): Promise<TokenPair> {
    await this.prisma.staffCredential.update({ where: { userId }, data: { failedAttempts: 0, lockedUntil: null } });
    await this.audit(userId, 'staff.sign_in');
    return this.tokens.issuePair(userId, 'DASHBOARD');
  }

  /** Each lock lasts twice as long as the last, up to a day, until a successful sign-in. */
  private async recordFailure(userId: string): Promise<void> {
    const { failedAttempts } = await this.prisma.staffCredential.update({
      where: { userId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    if (failedAttempts < MAX_FAILURES) return;

    const lockMs = Math.min(BASE_LOCK_MS * 2 ** (failedAttempts - MAX_FAILURES), MAX_LOCK_MS);
    await this.prisma.staffCredential.update({ where: { userId }, data: { lockedUntil: new Date(Date.now() + lockMs) } });
    await this.audit(userId, 'staff.locked');
  }

  private async audit(userId: string, action: string): Promise<void> {
    await this.prisma.auditLog.create({ data: { actorId: userId, action, targetType: 'user', targetId: userId } });
  }
}
