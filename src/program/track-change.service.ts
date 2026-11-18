import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { assertTrackFitsSection } from '../common/sections.js';
import { isUniqueViolation } from '../common/staff-api.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';
import { PlanService } from './plan.service.js';

/** The app's short name for the original tracks. */
export const ORIGINAL_TRACK = { advanced: 'ADVANCED', steady: 'STEADY', stabilization: 'STABILIZATION' } as const;

const OPEN_TRANSFER = ['PENDING_ADMIN', 'PENDING_TEACHER'] as const;
const notFound = () => new ApiError(404, 'not_found');

const REQUEST_SELECT = {
  id: true,
  reason: true,
  status: true,
  createdAt: true,
  decidedAt: true,
  fromTrack: { select: { id: true, name: true } },
  toTrack: { select: { id: true, name: true } },
} as const;

/**
 * Moving a student to another track. A student without a circle changes it herself. In a circle she asks her
 * teacher: a circle holds one track, so an approved change takes her out of it, and the supervisor places her
 * in a circle of the new track, where her new plan begins.
 */
@Injectable()
export class TrackChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /** The student's open request, or the last one decided, for the app's plan screen. */
  async latestFor(studentId: string) {
    const request = await this.prisma.trackChangeRequest.findFirst({
      where: { studentId, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      select: REQUEST_SELECT,
    });
    return request ?? null;
  }

  async request(studentId: string, dto: { trackCode: string; reason: string }) {
    const student = await this.prisma.user.findFirst({
      where: { id: studentId, role: 'STUDENT', status: 'ACTIVE' },
      select: { trackTemplateId: true, section: true },
    });
    if (!student) throw notFound();
    // A review track is given only after the admission test, never chosen by the student.
    const track = await this.prisma.trackTemplate.findFirst({ where: { code: dto.trackCode, active: true, kind: { not: 'REVIEW' } }, select: { id: true, name: true, recitationMode: true } });
    if (!track) throw new ApiError(409, 'track_closed');
    assertTrackFitsSection(track.recitationMode, student.section);
    if (track.id === student.trackTemplateId) throw new ApiError(409, 'same_track');

    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null },
      select: { circleId: true },
    });
    if (!membership) {
      await this.applyTrack(studentId, track.id, { startNow: null });
      return { status: 'APPLIED' as const };
    }

    try {
      const created = await this.prisma.trackChangeRequest.create({
        data: { studentId, fromTrackId: student.trackTemplateId, toTrackId: track.id, circleId: membership.circleId, reason: dto.reason },
        select: { id: true },
      });
      await this.notifications.notifyTeacherOf(studentId, {
        type: 'GENERAL',
        title: 'طلب تغيير مسار',
        body: `{{طالب يطلب|طالبة تطلب}} الانتقال إلى ${track.name}.`,
        dedupeKey: `track-change:${created.id}`,
      });
      return { status: 'PENDING' as const, id: created.id };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'request_exists');
      throw error;
    }
  }

  async cancel(studentId: string): Promise<void> {
    const { count } = await this.prisma.trackChangeRequest.updateMany({
      where: { studentId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    if (count !== 1) throw notFound();
  }

  /** Pending requests from students still in this teacher's circles. */
  async pendingForTeacher(teacherId: string) {
    const requests = await this.prisma.trackChangeRequest.findMany({
      where: {
        status: 'PENDING',
        circle: { teacherId, archivedAt: null },
        student: { memberships: { some: { leftAt: null, circle: { teacherId } } } },
      },
      orderBy: { createdAt: 'asc' },
      select: { ...REQUEST_SELECT, student: { select: { id: true, fullName: true } } },
    });
    return requests.map(({ student, ...request }) => ({ ...request, student: { id: student.id, name: student.fullName } }));
  }

  /** The scope's requests, newest first, so the supervisor sees what is waiting and what was decided. */
  async forScope(scopeId: string) {
    const requests = await this.prisma.trackChangeRequest.findMany({
      where: { circle: { scopeId }, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        ...REQUEST_SELECT,
        student: { select: { id: true, fullName: true, memberships: { where: { leftAt: null }, select: { id: true } } } },
        circle: { select: { id: true, name: true, teacher: { select: { fullName: true } } } },
        decidedBy: { select: { fullName: true } },
      },
    });
    return requests.map(({ student, circle, decidedBy, ...request }) => ({
      ...request,
      student: { id: student.id, name: student.fullName },
      circle: circle && { id: circle.id, name: circle.name, teacherName: circle.teacher?.fullName ?? null },
      decidedBy: decidedBy?.fullName ?? null,
      /** Approved and not yet placed in a circle of the new track. */
      awaitingPlacement: request.status === 'APPROVED' && student.memberships.length === 0,
    }));
  }

  async decide(teacher: StaffActor, requestId: string, approve: boolean): Promise<void> {
    const request = await this.prisma.trackChangeRequest.findFirst({
      where: { id: requestId, status: 'PENDING', circle: { teacherId: teacher.id, archivedAt: null } },
      select: {
        id: true,
        studentId: true,
        circleId: true,
        toTrackId: true,
        toTrack: { select: { name: true, active: true, recitationMode: true } },
        circle: { select: { scopeId: true } },
        student: { select: { section: true } },
      },
    });
    if (!request?.circleId || !request.circle) throw notFound();
    const circleId = request.circleId;
    if (approve && !request.toTrack.active) throw new ApiError(409, 'track_closed');
    if (approve) assertTrackFitsSection(request.toTrack.recitationMode, request.student.section);

    await this.prisma.$transaction(async (tx) => {
      const decided = await tx.trackChangeRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: teacher.id, decidedAt: new Date() },
      });
      if (decided.count !== 1) throw new ApiError(409, 'invalid_request_state');
      if (!approve) return;

      // The circle holds the old track, so the student leaves it and waits to be placed in one of the new track.
      const left = await tx.circleMembership.updateMany({ where: { studentId: request.studentId, circleId, leftAt: null }, data: { leftAt: new Date() } });
      if (left.count !== 1) throw notFound();
      await tx.liveSession.updateMany({ where: { circleId, studentId: request.studentId, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
    });

    if (approve) {
      await this.applyTrack(request.studentId, request.toTrackId, { startNow: false });
      await this.notifications.notifySupervisorsOf(request.circle.scopeId, {
        type: 'GENERAL',
        title: '{{طالب|طالبة}} بانتظار الإسناد',
        body: `تغيّر المسار إلى ${request.toTrack.name}، {{ويحتاج|وتحتاج}} إلى حلقة من هذا المسار.`,
        dedupeKey: `track-change-placement:${request.id}`,
      });
    }
    await this.notifications.send([request.studentId], {
      type: 'EVALUATION',
      title: approve ? 'قُبل طلب تغيير المسار' : 'لم يُقبل طلب تغيير المسار',
      body: approve
        ? `مسارك الآن ${request.toTrack.name}، {{وسيُسندك|وستُسندك}} الإدارة إلى حلقة جديدة قريبًا.`
        : `{{بقيت|بقيتِ}} على مسارك الحالي. {{تواصل|تواصلي}} مع {{معلمك|معلمتك}} لمعرفة السبب.`,
      dedupeKey: `track-change-decision:${request.id}`,
    });
    await this.audit.record(teacher, approve ? 'track_change.approve' : 'track_change.reject', { type: 'student', id: request.studentId }, { toTrackId: request.toTrackId });
  }

  /**
   * Moves a student who passed a review track's final test to a main track. Her circle holds the review track, so she
   * leaves it and waits for the supervisor to place her in a circle of the new one, where her new plan begins.
   */
  async moveAfterReview(actor: StaffActor, studentId: string, trackId: string): Promise<void> {
    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null },
      select: { circleId: true, circle: { select: { scopeId: true } } },
    });
    if (membership) {
      await this.prisma.$transaction([
        this.prisma.circleMembership.updateMany({ where: { studentId, circleId: membership.circleId, leftAt: null }, data: { leftAt: new Date() } }),
        this.prisma.liveSession.updateMany({ where: { circleId: membership.circleId, studentId, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } }),
      ]);
    }
    await this.applyTrack(studentId, trackId, { startNow: false });

    const track = await this.prisma.trackTemplate.findUniqueOrThrow({ where: { id: trackId }, select: { name: true } });
    if (membership) {
      await this.notifications.notifySupervisorsOf(membership.circle.scopeId, {
        type: 'GENERAL',
        title: '{{طالب|طالبة}} بانتظار الإسناد',
        body: `{{اجتاز|اجتازت}} المراجعة {{وانتقل|وانتقلت}} إلى ${track.name}، {{ويحتاج|وتحتاج}} إلى حلقة من هذا المسار.`,
        dedupeKey: `review-move:${studentId}:${trackId}`,
      });
    }
    await this.notifications.send([studentId], {
      type: 'EVALUATION',
      title: 'انتقلت إلى مسار جديد',
      body: `بعد اجتياز المراجعة أصبح مسارك ${track.name}، {{وسيُسندك|وستُسندك}} الإدارة إلى حلقة قريبًا.`,
      dedupeKey: `review-move-student:${studentId}:${trackId}`,
    });
    await this.audit.record(actor, 'review.move', { type: 'student', id: studentId }, { toTrackId: trackId });
  }

  /**
   * Puts the student on the track and begins the plan again. `startNow: null` keeps the rule the administration
   * uses: the new plan begins at once for a student who had one or is in a circle.
   */
  private async applyTrack(studentId: string, trackId: string, { startNow }: { startNow: boolean | null }): Promise<void> {
    const track = await this.prisma.trackTemplate.findUniqueOrThrow({ where: { id: trackId }, select: { code: true } });
    const student = await this.prisma.user.findUniqueOrThrow({ where: { id: studentId }, select: { trackStart: true } });
    const isStabilization = track.code === 'stabilization';
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: studentId },
        data: {
          trackTemplateId: trackId,
          trackId: ORIGINAL_TRACK[track.code as keyof typeof ORIGINAL_TRACK] ?? null,
          // Only the stabilization track has a starting point.
          trackStart: isStabilization ? (student.trackStart ?? 'KAHF') : null,
        },
      }),
      // A transfer was to a circle of the old track.
      this.prisma.transferRequest.updateMany({ where: { studentId, status: { in: [...OPEN_TRANSFER] } }, data: { status: 'CANCELLED' } }),
    ]);

    let begin = startNow;
    if (begin === null) {
      const [hadPlan, inCircle] = await Promise.all([
        this.prisma.studentPlan.count({ where: { studentId } }),
        this.prisma.circleMembership.count({ where: { studentId, leftAt: null } }),
      ]);
      begin = hadPlan > 0 || inCircle > 0;
    }
    await this.plans.restartPlan(studentId, begin);
  }
}
