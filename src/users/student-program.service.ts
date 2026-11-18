import { Injectable } from '@nestjs/common';
import { BadgesService } from '../badges/badges.service.js';
import { ApiError } from '../common/api-error.js';
import { isUniqueViolation, riyadhDate } from '../common/staff-api.js';
import { findSurah } from '../common/surahs.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../program/notifications.service.js';
import { PlanService } from '../program/plan.service.js';
import { SettingsService } from '../program/settings.service.js';
import { ismaStateOf } from '../teacher/isma.service.js';
import { isSupportKey, supportTicketOf } from '../common/support-keys.js';

const MAX_WRAP_COUNT = 100;

/** What a student's own app reads and records. Every query is limited to the signed-in student. */
@Injectable()
export class StudentProgramService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly settings: SettingsService,
    private readonly notifier: NotificationsService,
    private readonly badgeService: BadgesService,
  ) {}

  async program(studentId: string) {
    const [summaries, week, gates] = await Promise.all([
      this.plans.summaries([studentId]),
      this.plans.weekFor(studentId),
      this.prisma.surahGate.findMany({ where: { studentId, status: 'PENDING' } }),
    ]);
    const [gate] = await this.plans.describeGates(gates);
    return {
      summary: summaries.get(studentId),
      week,
      // The teacher's decision and its score belong to the teacher's view until it is made.
      gate: gate ?? null,
      tadabbur: gate ? await this.tadabbur(studentId, gate.surah) : null,
    };
  }

  completeWird(studentId: string) {
    return this.plans.completeNextUnit(studentId, 'STUDENT');
  }

  async markTafsirRead(studentId: string, surah: number): Promise<void> {
    await this.openGateOrThrow(studentId, surah);
    await this.prisma.surahGate.updateMany({
      where: { studentId, surah, status: 'PENDING', tafsirDoneAt: null },
      data: { tafsirDoneAt: new Date() },
    });
  }

  async markLessonAttended(studentId: string, surah: number): Promise<void> {
    await this.openGateOrThrow(studentId, surah);
    await this.prisma.surahGate.updateMany({
      where: { studentId, surah, status: 'PENDING', lessonAttendedAt: null },
      data: { lessonAttendedAt: new Date() },
    });
  }

  async addWrap(studentId: string, surah: number): Promise<{ count: number }> {
    await this.openGateOrThrow(studentId, surah);
    await this.prisma.surahGate.updateMany({
      where: { studentId, surah, status: 'PENDING', wrapCount: { lt: MAX_WRAP_COUNT } },
      data: { wrapCount: { increment: 1 } },
    });
    const { wrapCount } = await this.prisma.surahGate.findUniqueOrThrow({
      where: { studentId_surah: { studentId, surah } },
      select: { wrapCount: true },
    });
    return { count: wrapCount };
  }

  async completePractical(studentId: string, taskId: string): Promise<void> {
    const task = await this.prisma.tadabburTask.findFirst({
      where: { id: taskId, content: { published: true } },
      select: { id: true },
    });
    if (!task) throw new ApiError(404, 'not_found');
    await this.prisma.practicalCompletion.createMany({ data: [{ taskId, studentId }], skipDuplicates: true });
  }

  async tadabbur(studentId: string, surah: number) {
    const content = await this.prisma.surahTadabbur.findFirst({
      where: { surah, published: true },
      include: {
        tasks: {
          orderBy: { position: 'asc' },
          include: { completions: { where: { studentId }, select: { studentId: true } } },
        },
      },
    });
    if (!content) return null;
    return {
      surah,
      surahName: findSurah(surah)?.name ?? null,
      lessonType: content.lessonType,
      sheikh: content.sheikh,
      schedule: content.schedule,
      link: content.link,
      journaling: content.journaling,
      tasks: content.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        note: task.note,
        done: task.completions.length > 0,
      })),
    };
  }

  async createSkipRequest(studentId: string, dto: { surah?: number; request: string; reason: string }) {
    try {
      const request = await this.prisma.skipRequest.create({
        data: { studentId, surah: dto.surah, request: dto.request, reason: dto.reason },
        select: { id: true, status: true },
      });
      await this.notifier.notifyTeacherOf(studentId, {
        type: 'GENERAL',
        title: 'طلب جديد من {{طالب|طالبة}}',
        body: dto.request,
        dedupeKey: `request:${request.id}`,
      });
      return request;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'request_exists');
      throw error;
    }
  }

  /** The student's circle page. Only what the student's own record and circle hold. */
  async circle(studentId: string) {
    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null },
      select: {
        circleId: true,
        circle: { select: { name: true, teacher: { select: { id: true, fullName: true } } } },
      },
    });
    if (!membership) return null;

    const now = new Date();
    const today = riyadhDate();
    const teacherId = membership.circle.teacher?.id;
    const [tasks, evaluations, nextSession, attendance, teacherBadges] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          circleId: membership.circleId,
          archivedAt: null,
          OR: [{ studentId: null }, { studentId }],
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          description: true,
          recurrence: true,
          dueAt: true,
          deadlineMinutes: true,
          completions: { where: { studentId }, select: { dueOn: true } },
        },
      }),
      this.prisma.evaluation.findMany({
        where: { studentId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, title: true, score: true, maxScore: true, comment: true, createdAt: true },
      }),
      this.prisma.liveSession.findFirst({
        where: {
          status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
          scheduledAt: { gte: new Date(now.getTime() - 3 * 60 * 60 * 1000) },
          OR: [{ studentId }, { circleId: membership.circleId, studentId: null }],
        },
        // A session running now comes before an earlier one that was never started.
        orderBy: [{ status: 'desc' }, { scheduledAt: 'asc' }],
        select: {
          id: true,
          kind: true,
          title: true,
          scheduledAt: true,
          status: true,
          studentId: true,
          entryMode: true,
          turns: { select: { studentId: true, position: true, status: true } },
        },
      }),
      this.prisma.evaluation.findUnique({
        where: { studentId_attendanceOn: { studentId, attendanceOn: today } },
        select: { attendance: true },
      }),
      teacherId ? this.badgeService.showcaseOf([teacherId]).then((map) => map.get(teacherId) ?? null) : null,
    ]);

    return {
      name: membership.circle.name,
      teacherName: membership.circle.teacher?.fullName ?? null,
      /** The badges the teacher chose to show, so her students see them. */
      teacherBadges,
      nextSession: nextSession && {
        id: nextSession.id,
        kind: nextSession.kind,
        title: nextSession.title,
        scheduledAt: nextSession.scheduledAt,
        status: nextSession.status,
        /** A session for one student has a voice room. One for the whole circle doesn't, except حلقة الإسماع. */
        individual: nextSession.studentId !== null,
        /** In حلقة الإسماع: her place in the queue, once the session has started. */
        isma:
          nextSession.kind === 'ISMA'
            ? { entryMode: nextSession.entryMode ?? 'OPEN', turn: ismaStateOf(nextSession.turns, studentId, nextSession.entryMode ?? 'OPEN') }
            : null,
      },
      todayAttendance: attendance?.attendance ?? null,
      tasks: tasks.map(({ completions, ...task }) => ({
        ...task,
        done: completions.some(({ dueOn }) => task.recurrence !== 'DAILY' || dueOn.getTime() === today.getTime()),
      })),
      evaluations: evaluations.map((row) => ({
        ...row,
        score: row.score === null ? null : Number(row.score),
        maxScore: Number(row.maxScore),
      })),
    };
  }

  /** Limited to tasks of the student's own circle. The primary key makes it safe to send twice. */
  async completeTask(studentId: string, taskId: string): Promise<void> {
    const task = await this.prisma.task.findFirst({
      where: {
        id: taskId,
        archivedAt: null,
        OR: [{ studentId }, { studentId: null, circle: { memberships: { some: { studentId, leftAt: null } } } }],
      },
      select: { id: true, title: true, recurrence: true, dueAt: true },
    });
    if (!task) throw new ApiError(404, 'not_found');

    const dueOn = task.recurrence === 'DAILY' || !task.dueAt ? riyadhDate() : riyadhDate(task.dueAt);
    const { count } = await this.prisma.taskCompletion.createMany({ data: [{ taskId, studentId, dueOn }], skipDuplicates: true });
    if (count === 1) {
      const student = await this.prisma.user.findUniqueOrThrow({ where: { id: studentId }, select: { fullName: true } });
      await this.notifier.notifyTeacherOf(studentId, {
        type: 'NEW_TASK',
        title: 'نُفّذت مهمة',
        body: `${student.fullName}: ${task.title}`,
        dedupeKey: `task-done:${task.id}:${studentId}:${dueOn.toISOString().slice(0, 10)}`,
      });
    }
  }

  async notifications(studentId: string) {
    const rows = await this.prisma.notification.findMany({
      where: { userId: studentId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, type: true, title: true, body: true, readAt: true, createdAt: true, dedupeKey: true },
    });
    return rows.map(({ dedupeKey, ...row }) => ({
      ...row,
      opens: dedupeKey?.startsWith('session')
        ? ('session' as const)
        : dedupeKey?.startsWith('stage-exam')
          ? ('stage-exam' as const)
          : isSupportKey(dedupeKey)
            ? ('support' as const)
            : null,
      /** The support conversation it opens, when it is about one. */
      ticketId: supportTicketOf(dedupeKey),
    }));
  }

  async markAllNotificationsRead(studentId: string): Promise<void> {
    await this.prisma.notification.updateMany({ where: { userId: studentId, readAt: null }, data: { readAt: new Date() } });
  }

  async markNotificationRead(studentId: string, id: string): Promise<void> {
    await this.prisma.notification.updateMany({ where: { id, userId: studentId, readAt: null }, data: { readAt: new Date() } });
  }

  /** What's showing now for this student's track, circle and scope. */
  async announcements(studentId: string) {
    const student = await this.prisma.user.findUniqueOrThrow({
      where: { id: studentId },
      select: {
        trackTemplateId: true,
        memberships: { where: { leftAt: null }, select: { circleId: true, circle: { select: { scopeId: true } } } },
      },
    });
    const membership = student.memberships.at(0);
    const now = new Date();
    return this.prisma.announcement.findMany({
      where: {
        kind: 'ANNOUNCEMENT',
        OR: [
          { scope: 'ALL' },
          ...(student.trackTemplateId ? [{ scope: 'TRACK' as const, trackTemplateId: student.trackTemplateId }] : []),
          ...(membership
            ? [
                { scope: 'CIRCLE' as const, circleId: membership.circleId },
                { scope: 'SCOPE' as const, scopeId: membership.circle.scopeId },
              ]
            : []),
        ],
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, title: true, body: true, startsAt: true, createdAt: true },
    });
  }

  badges(studentId: string) {
    return this.badgeService.forStudent(studentId);
  }

  pinBadges(studentId: string, badgeIds: string[]) {
    return this.badgeService.setPins(studentId, badgeIds);
  }

  /** Public settings the app reads at launch, with no account needed. */
  async appConfig() {
    const [features, pledges, pages, packs, translations] = await Promise.all([
      this.settings.get('features'),
      this.settings.get('pledges'),
      this.prisma.infoPage.findMany({ select: { slug: true, title: true, body: true } }),
      this.prisma.languagePack.findMany({ select: { code: true, updatedAt: true } }),
      this.prisma.translation.findMany({ where: { status: 'APPROVED' }, select: { id: true, language: true, source: true, updatedAt: true } }),
    ]);
    return {
      languages: { ar: true, en: features.englishEnabled },
      /** When each uploaded interface file last changed, so the app downloads it only when it must. */
      languagePacks: packs,
      /** The approved verse translations the app can read. */
      translations,
      smartRecitation: { enabled: features.smartRecitation, offline: features.smartRecitation && features.offlineRecitation },
      pledges,
      pages,
    };
  }

  /** An interface file the administration uploaded. Null while there is none. */
  async languagePack(code: string) {
    const pack = await this.prisma.languagePack.findUnique({ where: { code }, select: { content: true, updatedAt: true } });
    return pack ?? { content: null, updatedAt: null };
  }

  /** One surah of an approved translation. A file under review or rejected is never served. */
  async translationSurah(id: string, surah: number) {
    const translation = await this.prisma.translation.findFirst({ where: { id, status: 'APPROVED' }, select: { id: true } });
    if (!translation) throw new ApiError(404, 'not_found');
    return this.prisma.translationVerse.findMany({
      where: { translationId: id, surah },
      orderBy: { ayah: 'asc' },
      select: { ayah: true, text: true },
    });
  }

  private async openGateOrThrow(studentId: string, surah: number): Promise<void> {
    const gate = await this.prisma.surahGate.findFirst({ where: { studentId, surah, status: 'PENDING' }, select: { id: true } });
    if (!gate) throw new ApiError(404, 'not_found');
  }
}
