import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { ATTENDANCE_DAY, attendanceRate, riyadhDate } from '../common/staff-api.js';
import type { AttendanceStatus } from '../generated/prisma/enums.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../program/notifications.service.js';
import { PlanService } from '../program/plan.service.js';
import { SettingsService } from '../program/settings.service.js';
import { assertTrackFitsCircle } from './circle-track.js';

const notFound = () => new ApiError(404, 'not_found');

export const announcementStatus = (item: { startsAt: Date | null; endsAt: Date | null }, now = new Date()) =>
  item.endsAt && item.endsAt <= now ? 'ended' : item.startsAt && item.startsAt > now ? 'scheduled' : 'visible';

@Injectable()
export class SupervisorProgramService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /** Who is keeping to their plan, who is behind, and each circle's commitment. */
  async planFollowUp(staff: StaffActor, filters: { circleId?: string; teacherId?: string; trackId?: string }) {
    const scopeId = this.scopeOf(staff);
    const members = await this.prisma.circleMembership.findMany({
      where: {
        leftAt: null,
        circle: {
          scopeId,
          archivedAt: null,
          ...(filters.circleId ? { id: filters.circleId } : {}),
          ...(filters.teacherId ? { teacherId: filters.teacherId } : {}),
        },
        ...(filters.trackId ? { student: { trackTemplateId: filters.trackId } } : {}),
      },
      select: {
        circle: { select: { id: true, name: true } },
        student: {
          select: {
            id: true,
            fullName: true,
            trackTemplate: { select: { name: true } },
          },
        },
      },
    });
    const summaries = await this.plans.summaries(members.map(({ student }) => student.id));
    const onPlan = members.filter(({ student }) => summaries.get(student.id)?.status !== 'no_plan');
    const behind = onPlan.filter(({ student }) => summaries.get(student.id)?.status === 'late');

    const circles = new Map<string, { id: string; name: string; values: number[] }>();
    for (const { circle, student } of members) {
      const entry = circles.get(circle.id) ?? { ...circle, values: [] };
      const commitment = summaries.get(student.id)?.commitment;
      if (commitment !== null && commitment !== undefined) entry.values.push(commitment);
      circles.set(circle.id, entry);
    }

    return {
      stats: {
        onPlan: onPlan.length,
        committed: onPlan.length - behind.length,
        committedPercent: onPlan.length === 0 ? null : Math.round(((onPlan.length - behind.length) / onPlan.length) * 100),
        behind: behind.length,
      },
      behind: behind.map(({ student, circle }) => {
        const summary = summaries.get(student.id);
        return {
          studentId: student.id,
          name: student.fullName,
          circle,
          track: student.trackTemplate?.name ?? null,
          delay: summary?.delay ?? null,
          behindDays: summary?.behindDays ?? 0,
        };
      }),
      circles: [...circles.values()]
        .map(({ values, ...circle }) => ({
          ...circle,
          commitment: values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
        }))
        .sort((a, b) => (b.commitment ?? -1) - (a.commitment ?? -1)),
    };
  }

  /** At most one reminder per student per day, even if the button is pressed again. */
  async remindStudent(staff: StaffActor, studentId: string): Promise<{ sent: boolean }> {
    const member = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null, circle: { scopeId: this.scopeOf(staff) } },
      select: { id: true },
    });
    if (!member) throw notFound();

    const sent = await this.notifications.send([studentId], {
      type: 'DAILY_WIRD',
      title: 'تذكير بوردك',
      body: 'تأخر وردك عن خطتك. أعانك الله، {{ابدأ|ابدئي}} بما تيسر اليوم.',
      dedupeKey: `reminder:${riyadhDate().toISOString().slice(0, 10)}`,
    });
    await this.audit.record(staff, 'student.remind', { type: 'student', id: studentId });
    return { sent: sent > 0 };
  }

  /** Each circle's track, and how many students are on each track in the scope. */
  async templates(staff: StaffActor) {
    const scopeId = this.scopeOf(staff);
    const [{ editTemplates }, tracks, circles, counts] = await Promise.all([
      this.settings.get('permissions'),
      this.prisma.trackTemplate.findMany({
        where: { active: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, kind: true, dailyUnit: true, dailyAyahs: true, duration: true },
      }),
      this.prisma.circle.findMany({
        where: { scopeId, archivedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          teacher: { select: { fullName: true } },
          trackTemplate: { select: { id: true, name: true } },
        },
      }),
      this.prisma.user.groupBy({
        by: ['trackTemplateId'],
        where: { role: 'STUDENT', memberships: { some: { leftAt: null, circle: { scopeId } } } },
        _count: true,
      }),
    ]);
    return {
      canEdit: editTemplates,
      tracks: tracks.map((track) => ({
        ...track,
        students: counts.find((row) => row.trackTemplateId === track.id)?._count ?? 0,
      })),
      circles: circles.map((circle) => ({
        id: circle.id,
        name: circle.name,
        teacherName: circle.teacher?.fullName ?? null,
        track: circle.trackTemplate,
      })),
    };
  }

  async setCircleTrack(staff: StaffActor, circleId: string, trackId: string): Promise<void> {
    const { editTemplates } = await this.settings.get('permissions');
    if (!editTemplates) throw new ApiError(403, 'templates_locked');

    const track = await this.prisma.trackTemplate.findFirst({ where: { id: trackId, active: true }, select: { id: true } });
    if (!track) throw notFound();
    const circle = await this.prisma.circle.findFirst({ where: { id: circleId, scopeId: this.scopeOf(staff), archivedAt: null }, select: { id: true } });
    if (!circle) throw notFound();
    await assertTrackFitsCircle(this.prisma, circleId, trackId);
    await this.prisma.circle.update({ where: { id: circleId }, data: { trackTemplateId: trackId } });
    await this.audit.record(staff, 'circle.set_track', { type: 'circle', id: circleId }, { trackId });
  }

  async stageReport(staff: StaffActor, filters: { circleId?: string; teacherId?: string; days?: number }) {
    const { passScore } = await this.settings.get('gate');
    const exams = await this.prisma.stageExam.findMany({
      where: {
        // A review track's final test isn't a seventh.
        finalKind: null,
        ...(filters.days ? { createdAt: { gte: new Date(Date.now() - filters.days * 24 * 60 * 60 * 1000) } } : {}),
        circle: {
          scopeId: this.scopeOf(staff),
          ...(filters.circleId ? { id: filters.circleId } : {}),
          ...(filters.teacherId ? { teacherId: filters.teacherId } : {}),
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        studentId: true,
        stage: true,
        score: true,
        passed: true,
        circleId: true,
        circle: { select: { name: true } },
        student: { select: { trackTemplate: { select: { name: true } } } },
      },
    });

    // A retake replaces the earlier result: each student counts once per stage, by the latest try.
    const latest = new Map<string, (typeof exams)[number]>();
    for (const exam of exams) {
      const key = `${exam.studentId}:${exam.stage}`;
      if (!latest.has(key)) latest.set(key, exam);
    }
    const rows = [...latest.values()];

    const groupBy = <T extends string>(keyOf: (exam: (typeof rows)[number]) => T) => {
      const groups = new Map<T, (typeof rows)>();
      for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
      return groups;
    };
    const summarize = (items: typeof rows) => ({
      tested: items.length,
      passed: items.filter(({ passed }) => passed).length,
      passRate: items.length === 0 ? null : Math.round((items.filter(({ passed }) => passed).length / items.length) * 100),
      average: items.length === 0 ? null : Math.round((items.reduce((sum, { score }) => sum + Number(score), 0) / items.length) * 10) / 10,
    });

    return {
      passScore,
      stats: { ...summarize(rows), needRetake: rows.filter(({ passed }) => !passed).length },
      byCircle: [...groupBy((row) => `${row.circleId}:${row.stage}`).values()].map((items) => ({
        circleId: items[0].circleId,
        circleName: items[0].circle?.name ?? null,
        stage: items[0].stage,
        ...summarize(items),
      })),
      byTrack: [...groupBy((row) => row.student.trackTemplate?.name ?? '').entries()].map(([track, items]) => ({
        track: track || null,
        passRate: summarize(items).passRate,
      })),
    };
  }

  /** Surahs finished and their gates. With `days`, the passed and skipped count those decided in that time; waiting ones always count. */
  async gateReport(staff: StaffActor, filters: { circleId?: string; teacherId?: string; days?: number }) {
    const circles = await this.prisma.circle.findMany({
      where: {
        scopeId: this.scopeOf(staff),
        archivedAt: null,
        ...(filters.circleId ? { id: filters.circleId } : {}),
        ...(filters.teacherId ? { teacherId: filters.teacherId } : {}),
      },
      select: { id: true, name: true, memberships: { where: { leftAt: null }, select: { studentId: true } } },
    });
    const gates = await this.prisma.surahGate.groupBy({
      by: ['studentId', 'status'],
      where: {
        studentId: { in: circles.flatMap((circle) => circle.memberships.map(({ studentId }) => studentId)) },
        ...(filters.days ? { OR: [{ status: 'PENDING' }, { decidedAt: { gte: new Date(Date.now() - filters.days * 24 * 60 * 60 * 1000) } }] } : {}),
      },
      _count: true,
      _avg: { score: true },
    });
    return circles.map((circle) => {
      const ids = new Set(circle.memberships.map(({ studentId }) => studentId));
      const own = gates.filter((row) => ids.has(row.studentId));
      const sum = (status: string) => own.filter((row) => row.status === status).reduce((total, row) => total + row._count, 0);
      return { circleId: circle.id, circleName: circle.name, passed: sum('PASSED'), skipped: sum('SKIPPED'), pending: sum('PENDING') };
    });
  }

  /** Attendance and recitations by circle and by teacher, over the chosen days. */
  async activityReport(staff: StaffActor, days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const circles = await this.prisma.circle.findMany({
      where: { scopeId: this.scopeOf(staff), archivedAt: null },
      select: { id: true, name: true, teacher: { select: { id: true, fullName: true } } },
    });
    const ids = circles.map(({ id }) => id);
    const [attendance, recitations, tasks, sessions] = await Promise.all([
      this.prisma.evaluation.groupBy({
        by: ['circleId', 'attendance'],
        where: { circleId: { in: ids }, createdAt: { gte: since }, ...ATTENDANCE_DAY },
        _count: true,
      }),
      this.prisma.evaluation.groupBy({
        by: ['circleId'],
        where: { circleId: { in: ids }, createdAt: { gte: since }, score: { not: null } },
        _count: true,
        _avg: { score: true },
      }),
      this.prisma.task.groupBy({ by: ['circleId'], where: { circleId: { in: ids }, createdAt: { gte: since } }, _count: true }),
      this.prisma.liveSession.groupBy({
        by: ['circleId'],
        where: { circleId: { in: ids }, status: 'COMPLETED', endedAt: { gte: since } },
        _count: true,
      }),
    ]);

    return circles.map((circle) => {
      const counts: Partial<Record<AttendanceStatus, number>> = {};
      for (const row of attendance) {
        if (row.circleId === circle.id && row.attendance) counts[row.attendance] = row._count;
      }
      const scored = recitations.find((row) => row.circleId === circle.id);
      return {
        circleId: circle.id,
        circleName: circle.name,
        teacher: circle.teacher && { id: circle.teacher.id, name: circle.teacher.fullName },
        attendanceRate: attendanceRate(counts),
        recitations: scored?._count ?? 0,
        averageScore: scored?._avg.score ? Math.round(Number(scored._avg.score) * 10) / 10 : null,
        tasksAssigned: tasks.find((row) => row.circleId === circle.id)?._count ?? 0,
        sessionsHeld: sessions.find((row) => row.circleId === circle.id)?._count ?? 0,
      };
    });
  }

  /** What the administration sent everyone, what reached this scope's tracks, and the scope's own. */
  async incomingAnnouncements(staff: StaffActor) {
    const scopeId = this.scopeOf(staff);
    const items = await this.prisma.announcement.findMany({
      where: {
        kind: 'ANNOUNCEMENT',
        OR: [{ scope: 'ALL' }, { scope: 'TRACK' }, { scopeId }, { circle: { scopeId } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        body: true,
        scope: true,
        startsAt: true,
        endsAt: true,
        createdAt: true,
        circle: { select: { name: true } },
        track: { select: { name: true } },
      },
    });
    return items.map(({ circle, track, ...item }) => ({
      ...item,
      audience: circle?.name ?? track?.name ?? null,
      status: announcementStatus(item),
    }));
  }

  private scopeOf(staff: StaffActor): string {
    if (!staff.scopeId) throw new ApiError(403, 'no_scope');
    return staff.scopeId;
  }
}
