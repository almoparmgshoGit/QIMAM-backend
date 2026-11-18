import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { assertTrackFitsSection } from '../common/sections.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlanService } from '../program/plan.service.js';
import {
  toLanguage,
  toNotificationType,
  toProfile,
  toStabilizationStart,
  toTrackId,
  type ApiNotificationType,
} from './profile.mapper.js';
import type { UpdateProfileDto } from './users.schemas.js';

const PROFILE_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  country: true,
  region: true,
  city: true,
  ageBand: true,
  section: true,
  trackTemplate: { select: { code: true } },
  trackStart: true,
  language: true,
  notificationPrefs: { select: { type: true, enabled: true } },
  memberships: { where: { leftAt: null }, select: { id: true } },
  admissionStatus: true,
  admissionNote: true,
  timeZone: true,
  reminderMinutes: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
    if (!user) throw new ApiError(401, 'invalid_token');
    return toProfile(user);
  }

  async updateProfile(userId: string, changes: UpdateProfileDto) {
    const notifications = Object.entries(changes.preferences?.notifications ?? {}) as [ApiNotificationType, boolean][];

    let trackTemplateId: string | undefined;
    if (changes.track) {
      // The track is chosen after the admission test is passed, never before.
      const student = await this.prisma.user.findUnique({ where: { id: userId }, select: { admissionStatus: true, section: true } });
      if (student?.admissionStatus !== 'ACCEPTED') throw new ApiError(409, 'admission_pending');
      // Once work has begun the plan is built on its track, so moving is an administrator's decision.
      const plan = await this.prisma.studentPlan.findUnique({ where: { studentId: userId }, select: { completedUnits: true } });
      if (plan && plan.completedUnits > 0) throw new ApiError(409, 'plan_in_progress');
      const template = await this.prisma.trackTemplate.findUnique({
        where: { code: changes.track.trackId },
        select: { id: true, active: true, kind: true, recitationMode: true },
      });
      if (!template?.active || template.kind !== 'MEMORIZATION') throw new ApiError(409, 'track_closed');
      assertTrackFitsSection(template.recitationMode, student.section);
      // A student stays on her circle's track. Moving means moving circle first.
      const membership = await this.prisma.circleMembership.findFirst({
        where: { studentId: userId, leftAt: null },
        select: { circle: { select: { trackTemplateId: true } } },
      });
      if (membership?.circle.trackTemplateId && membership.circle.trackTemplateId !== template.id) {
        throw new ApiError(409, 'track_set_by_circle');
      }
      trackTemplateId = template.id;
      if (plan) await this.prisma.studentPlan.delete({ where: { studentId: userId } });
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(changes.track && {
          trackId: toTrackId(changes.track.trackId),
          trackTemplateId,
          trackStart: changes.track.trackStart ? toStabilizationStart(changes.track.trackStart) : null,
        }),
        ...(changes.preferences?.language && { language: toLanguage(changes.preferences.language) }),
        ...(changes.preferences?.timeZone && { timeZone: changes.preferences.timeZone }),
        ...(changes.preferences?.reminderMinutes !== undefined && { reminderMinutes: changes.preferences.reminderMinutes }),
        notificationPrefs: {
          upsert: notifications.map(([key, enabled]) => {
            const type = toNotificationType(key);
            return { where: { userId_type: { userId, type } }, create: { type, enabled }, update: { enabled } };
          }),
        },
      },
    });
    if (changes.track) await this.plans.startPlan(userId);
    return this.getProfile(userId);
  }

  async deleteAccount(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (!user) return;

    await this.prisma.$transaction(async (tx) => {
      // The audit row keeps the id only, so nothing identifying survives.
      await tx.auditLog.create({
        data: { actorId: userId, actorRole: 'STUDENT', action: 'user.delete_account', targetType: 'user', targetId: userId },
      });
      if (user.phone) await tx.otpChallenge.deleteMany({ where: { phone: user.phone } });
      // Tokens, consents, memberships and the rest of their data go with the row, through the foreign keys.
      await tx.user.delete({ where: { id: userId } });
    });
  }
}
