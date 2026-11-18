import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { assertTrackFitsSection } from '../common/sections.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AccountStatus, ConsentType, NotificationType, Role } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlanService } from '../program/plan.service.js';
import { SettingsService } from '../program/settings.service.js';
import { toSection, toStabilizationStart, toTrackId } from '../users/profile.mapper.js';
import type { CompleteRegistrationDto, RegistrationDto, RequestOtpDto, VerifyOtpDto } from './auth.schemas.js';
import { OtpService } from './otp.service.js';
import { TokensService } from './tokens.service.js';

const CONSENTS: ConsentType[] = ['TERMS_AND_PRIVACY', 'PLAN_PLEDGE', 'SERIOUSNESS_PLEDGE'];

const DEFAULT_NOTIFICATIONS: { type: NotificationType; enabled: boolean }[] = [
  { type: 'DAILY_WIRD', enabled: true },
  { type: 'WEEKLY_REVIEW', enabled: true },
  { type: 'NEW_TASK', enabled: true },
  { type: 'EVALUATION', enabled: true },
  { type: 'BADGES', enabled: true },
  { type: 'GENERAL', enabled: true },
  { type: 'ENCOURAGEMENT', enabled: true },
];

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokensService,
    private readonly settings: SettingsService,
    private readonly plans: PlanService,
  ) {}

  requestOtp({ phone, purpose }: RequestOtpDto): Promise<void> {
    return this.otp.request(phone, purpose === 'register' ? 'REGISTER' : 'LOGIN');
  }

  /** Only someone holding a correct code can learn here whether the number has an account. */
  async verifyOtp({ phone, code, registration }: VerifyOtpDto) {
    await this.otp.verify(phone, code);

    let user = await this.prisma.user.findUnique({ where: { phone }, select: { id: true, role: true, status: true } });

    // The code proves the number is theirs. An existing account signs in, and registration data never overwrites it.
    if (!user && registration) user = await this.createStudent(phone, registration);
    if (!user) return { registrationToken: await this.tokens.issueRegistrationToken(phone) };

    return this.signIn(user);
  }

  /** Creates the account for a number verified earlier, with no second code. */
  async completeRegistration({ registrationToken, ...registration }: CompleteRegistrationDto) {
    const phone = await this.tokens.verifyRegistrationToken(registrationToken);

    const existing = await this.prisma.user.count({ where: { phone } });
    if (existing > 0) throw new ApiError(409, 'already_registered');

    const user = await this.createStudent(phone, registration);
    if (!user) throw new ApiError(409, 'already_registered');
    return this.signIn(user);
  }

  private async signIn(user: { id: string; role: Role; status: AccountStatus }) {
    if (user.status !== 'ACTIVE' || user.role !== 'STUDENT') throw new ApiError(403, 'account_unavailable');

    const pair = await this.tokens.issuePair(user.id);
    await this.prisma.auditLog.create({
      data: { actorId: user.id, actorRole: 'STUDENT', action: 'auth.sign_in', targetType: 'user', targetId: user.id },
    });
    return pair;
  }

  private async createStudent(phone: string, registration: RegistrationDto) {
    const select = { id: true, role: true, status: true } as const;
    const section = toSection(registration.section);
    // A new student has no track until the admission test. An old copy of the app still sends one.
    let template: { id: string } | null = null;
    if (registration.trackId) {
      // A stopped track takes no new students, whatever an old copy of the app sends.
      const found = await this.prisma.trackTemplate.findUnique({
        where: { code: registration.trackId },
        select: { id: true, active: true, kind: true, recitationMode: true },
      });
      if (!found?.active || found.kind !== 'MEMORIZATION') throw new ApiError(409, 'track_closed');
      assertTrackFitsSection(found.recitationMode, section);
      template = found;
    }
    // Acceptance is recorded against the wording in force now. The version rises when the wording changes.
    const [{ version }, admission] = await Promise.all([this.settings.get('pledges'), this.settings.get('admission')]);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            phone,
            fullName: registration.fullName,
            country: registration.country,
            region: registration.region ?? null,
            city: registration.city ?? null,
            ageBand: registration.ageBand,
            section,
            trackId: registration.trackId ? toTrackId(registration.trackId) : null,
            trackTemplateId: template?.id ?? null,
            trackStart: registration.trackStart ? toStabilizationStart(registration.trackStart) : null,
            admissionStatus: admission.required ? 'PENDING' : 'ACCEPTED',
            consents: { create: CONSENTS.map((type) => ({ type, version: String(version) })) },
            notificationPrefs: { create: DEFAULT_NOTIFICATIONS },
          },
          select,
        });
        await tx.auditLog.create({
          data: { actorId: created.id, actorRole: 'STUDENT', action: 'auth.register', targetType: 'user', targetId: created.id },
        });
        return created;
      });
      // With no test required the plan begins at sign-up. Otherwise it begins on acceptance.
      await this.plans.startPlan(user.id);
      return user;
    } catch (error) {
      // Two registrations for one number at the same moment: the phone's unique rule lets one through.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.user.findUnique({ where: { phone }, select });
      }
      throw error;
    }
  }
}
