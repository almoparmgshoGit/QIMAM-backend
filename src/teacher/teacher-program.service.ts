import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { riyadhDate } from '../common/staff-api.js';
import { SURAH_PAGES } from '../common/mushaf.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../program/notifications.service.js';
import { buildUnits, DAY_MS, unitLabel } from '../program/plan-engine.js';
import { PlanService } from '../program/plan.service.js';
import { SettingsService } from '../program/settings.service.js';
import { announcementStatus } from '../supervisor/supervisor-program.service.js';

const WEEKS_IN_CHART = 4;
const notFound = () => new ApiError(404, 'not_found');

/** A teacher's decisions on gates, skip requests and stage exams, always through their current circles. */
@Injectable()
export class TeacherProgramService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async listGates(teacher: StaffActor) {
    const gates = await this.prisma.surahGate.findMany({
      where: { status: 'PENDING', student: this.inTeacherCircle(teacher.id) },
      orderBy: { openedOn: 'asc' },
      include: { student: { select: { fullName: true, trackTemplate: { select: { name: true } } } } },
    });
    const [described, reflections] = await Promise.all([
      this.plans.describeGates(gates),
      this.prisma.tadabburReflection.findMany({
        where: { OR: gates.map(({ studentId, surah }) => ({ studentId, surah })) },
        select: { studentId: true, surah: true, body: true },
      }),
    ]);
    return described.map((gate, index) => ({
      ...gate,
      studentName: gates[index].student.fullName,
      track: gates[index].student.trackTemplate?.name ?? null,
      /** What the student wrote about the lesson for this surah. */
      reflection: reflections.find((row) => row.studentId === gate.studentId && row.surah === gate.surah)?.body ?? null,
    }));
  }

  async approveGate(teacher: StaffActor, gateId: string, score: number | null): Promise<void> {
    const gate = await this.ownGate(teacher, gateId);
    await this.plans.approveGate(teacher, gate, score);
    await this.notifications.send([gate.studentId], {
      type: 'EVALUATION',
      title: 'اعتُمدت البوابة',
      body: 'فُتحت لكِ السورة التالية. بارك الله فيك.',
      dedupeKey: `gate-pass:${gate.id}`,
    });
  }

  async returnGate(teacher: StaffActor, gateId: string, note: string | null): Promise<void> {
    const gate = await this.ownGate(teacher, gateId);
    await this.plans.returnGate(teacher, gate, note);
    await this.notifications.send([gate.studentId], {
      type: 'EVALUATION',
      title: 'أعادت معلمتك البوابة',
      body: note ?? 'أعيدي التغليف ثم الاختبار.',
    });
  }

  async confirmLesson(teacher: StaffActor, gateId: string): Promise<void> {
    const gate = await this.ownGate(teacher, gateId);
    // A teacher who saw the student there can confirm before the student has marked it.
    const now = new Date();
    await this.prisma.surahGate.updateMany({
      where: { id: gate.id, status: 'PENDING' },
      data: { lessonAttendedAt: gate.lessonAttendedAt ?? now, lessonConfirmedAt: now },
    });
    await this.audit.record(teacher, 'gate.lesson_confirm', { type: 'student', id: gate.studentId }, { surah: gate.surah });
  }

  /** The student goes back to attending, and hears why the gate didn't move. */
  async rejectLesson(teacher: StaffActor, gateId: string): Promise<void> {
    const gate = await this.ownGate(teacher, gateId);
    await this.prisma.surahGate.updateMany({
      where: { id: gate.id, status: 'PENDING' },
      data: { lessonAttendedAt: null, lessonConfirmedAt: null },
    });
    await this.notifications.send([gate.studentId], {
      type: 'EVALUATION',
      title: 'لم يتأكد حضورك لدرس التدبر',
      body: 'يرجى حضور الدرس المباشر ثم تأكيد ذلك من جديد.',
    });
    await this.audit.record(teacher, 'gate.lesson_reject', { type: 'student', id: gate.studentId }, { surah: gate.surah });
  }

  async listSkipRequests(teacher: StaffActor) {
    const requests = await this.prisma.skipRequest.findMany({
      where: { status: 'PENDING', student: this.inTeacherCircle(teacher.id) },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        surah: true,
        request: true,
        reason: true,
        createdAt: true,
        student: { select: { id: true, fullName: true, trackTemplate: { select: { name: true } } } },
      },
    });
    return requests.map(({ student, ...row }) => ({
      ...row,
      student: { id: student.id, name: student.fullName, track: student.trackTemplate?.name ?? null },
    }));
  }

  /** Approving a surah moves the student past it. Any other request is recorded for the teacher to act on. */
  async decideSkipRequest(teacher: StaffActor, id: string, approve: boolean): Promise<void> {
    const request = await this.prisma.skipRequest.findFirst({
      where: { id, status: 'PENDING', student: this.inTeacherCircle(teacher.id) },
      select: { id: true, studentId: true, surah: true },
    });
    if (!request) throw notFound();

    if (approve && request.surah) await this.plans.skipCurrentSurah(teacher, request.studentId, request.surah);

    const { count } = await this.prisma.skipRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: teacher.id, decidedAt: new Date() },
    });
    if (count !== 1) throw new ApiError(409, 'invalid_request_state');
    await this.audit.record(teacher, approve ? 'skip.approve' : 'skip.reject', { type: 'student', id: request.studentId }, { surah: request.surah });
  }

  async recordStageExam(teacher: StaffActor, dto: { studentId: string; stage: number; score: number }) {
    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId: dto.studentId, leftAt: null, circle: { teacherId: teacher.id, archivedAt: null } },
      select: { circleId: true },
    });
    if (!membership) throw notFound();

    const { passScore } = await this.settings.get('gate');
    const exam = await this.prisma.stageExam.create({
      data: {
        studentId: dto.studentId,
        teacherId: teacher.id,
        circleId: membership.circleId,
        stage: dto.stage,
        score: dto.score,
        passed: dto.score >= passScore,
      },
      select: { id: true, passed: true },
    });
    await this.audit.record(teacher, 'stage_exam.create', { type: 'student', id: dto.studentId }, { stage: dto.stage, score: dto.score });
    await this.notifications.send([dto.studentId], {
      type: 'EVALUATION',
      title: 'نتيجة الاختبار المرحلي',
      body: `المرحلة ${dto.stage}: ${dto.score} من 10 · ${exam.passed ? 'ناجحة' : 'تحتاجين إلى إعادة الاختبار'}`,
      dedupeKey: `stage-exam:${exam.id}`,
    });
    return exam;
  }

  /** What this teacher recorded, newest first. A student who moved away stays here as history. */
  async listStageExams(teacher: StaffActor) {
    const [rows, gate] = await Promise.all([
      this.prisma.stageExam.findMany({
        where: { teacherId: teacher.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, stage: true, score: true, passed: true, createdAt: true, student: { select: { id: true, fullName: true } } },
      }),
      this.settings.get('gate'),
    ]);
    return {
      passScore: gate.passScore,
      items: rows.map(({ student, score, ...row }) => ({ ...row, score: Number(score), student: { id: student.id, name: student.fullName } })),
    };
  }

  /** The same reach a student has: everyone's, the scope's, the teacher's circles and their tracks. */
  async announcements(teacher: StaffActor) {
    const circles = await this.prisma.circle.findMany({
      where: { teacherId: teacher.id, archivedAt: null },
      select: { id: true, trackTemplateId: true },
    });
    const tracks = circles.flatMap(({ trackTemplateId }) => (trackTemplateId ? [trackTemplateId] : []));
    const items = await this.prisma.announcement.findMany({
      where: {
        kind: 'ANNOUNCEMENT',
        OR: [
          { scope: 'ALL' },
          ...(teacher.scopeId ? [{ scope: 'SCOPE' as const, scopeId: teacher.scopeId }] : []),
          { scope: 'CIRCLE', circleId: { in: circles.map(({ id }) => id) } },
          { scope: 'TRACK', trackTemplateId: { in: tracks } },
        ],
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
    return items.map(({ circle, track, ...item }) => ({ ...item, audience: circle?.name ?? track?.name ?? null, status: announcementStatus(item) }));
  }

  /** The parts of a student's file the profile summary leaves out. */
  async studentRecord(teacher: StaffActor, studentId: string) {
    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null, circle: { teacherId: teacher.id, archivedAt: null } },
      select: { circleId: true },
    });
    if (!membership) throw notFound();
    const { openRecord } = await this.settings.get('permissions');
    const circleLimit = openRecord ? {} : { circleId: membership.circleId };

    const [plan, days, recitations, exams, attendance, tasks] = await Promise.all([
      this.prisma.studentPlan.findUnique({
        where: { studentId },
        select: {
          surahOrder: true,
          template: { select: { dailyUnit: true } },
          logs: { orderBy: { doneOn: 'desc' }, take: 100, select: { unitIndex: true, source: true, doneOn: true } },
        },
      }),
      this.prisma.dayCompletion.findMany({ where: { studentId }, orderBy: { doneOn: 'desc' }, take: 60, select: { doneOn: true, kind: true, detail: true } }),
      this.prisma.evaluation.findMany({
        where: { studentId, surah: { not: null }, ...circleLimit },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, title: true, score: true, maxScore: true, comment: true, segmentStatus: true, attendance: true, createdAt: true },
      }),
      this.prisma.stageExam.findMany({
        where: { studentId, ...circleLimit },
        orderBy: { createdAt: 'desc' },
        select: { id: true, stage: true, score: true, passed: true, createdAt: true },
      }),
      this.prisma.evaluation.findMany({
        where: { studentId, attendance: { not: null }, ...circleLimit },
        orderBy: { createdAt: 'desc' },
        take: 60,
        select: { id: true, attendance: true, title: true, createdAt: true },
      }),
      this.prisma.task.findMany({
        where: { circleId: membership.circleId, archivedAt: null, OR: [{ studentId: null }, { studentId }] },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          title: true,
          recurrence: true,
          dueAt: true,
          completions: { where: { studentId }, orderBy: { dueOn: 'desc' }, take: 1, select: { dueOn: true } },
        },
      }),
    ]);

    const dailyUnit = plan?.template.dailyUnit;
    const units = dailyUnit ? buildUnits(dailyUnit, plan.surahOrder) : [];
    const today = riyadhDate().getTime();
    return {
      memorized: (plan?.logs ?? []).flatMap(({ unitIndex, source, doneOn }) => {
        const unit = units[unitIndex];
        return unit && dailyUnit ? [{ id: String(unitIndex), label: unitLabel(unit, dailyUnit), source, doneOn }] : [];
      }),
      days,
      recitations: recitations.map(({ score, maxScore, comment, ...row }) => ({
        ...row,
        score: score === null ? null : Number(score),
        maxScore: Number(maxScore),
        note: comment,
      })),
      stageExams: exams.map(({ score, ...row }) => ({ ...row, score: Number(score) })),
      attendance,
      tasks: tasks.map(({ completions, ...task }) => {
        const last = completions[0]?.dueOn ?? null;
        return { ...task, lastDoneOn: last, done: last !== null && (task.recurrence !== 'DAILY' || last.getTime() === today) };
      }),
    };
  }

  /** Pages memorized per week over the last four weeks, by track, oldest first. */
  async weeklyPages(teacher: StaffActor) {
    const now = Date.now();
    const since = new Date(now - WEEKS_IN_CHART * 7 * DAY_MS);
    const plans = await this.prisma.studentPlan.findMany({
      where: { student: this.inTeacherCircle(teacher.id) },
      select: {
        surahOrder: true,
        template: { select: { name: true, dailyUnit: true } },
        logs: { where: { doneOn: { gte: since } }, select: { doneOn: true, unitIndex: true } },
      },
    });

    const blankWeeks = () => Array.from({ length: WEEKS_IN_CHART }, () => 0);
    const result = new Map<string, number[]>();
    for (const plan of plans) {
      const weeks = result.get(plan.template.name) ?? blankWeeks();
      const pageSize = plan.template.dailyUnit === 'HALF_PAGE' ? 0.5 : plan.template.dailyUnit === 'PAGE' ? 1 : null;
      for (const log of plan.logs) {
        const week = WEEKS_IN_CHART - 1 - Math.floor((now - log.doneOn.getTime()) / (7 * DAY_MS));
        if (week < 0 || week >= WEEKS_IN_CHART) continue;
        // A surah-by-surah unit is as long as its surah.
        const size = pageSize ?? SURAH_PAGES[plan.surahOrder[log.unitIndex]]?.length ?? 0;
        weeks[week] += size;
      }
      result.set(plan.template.name, weeks);
    }
    // Pages the teacher heard recited, counted by the mushaf pages each recitation covers.
    const heard = await this.prisma.evaluation.findMany({
      where: { teacherId: teacher.id, surah: { not: null }, score: { not: null }, createdAt: { gte: since } },
      select: {
        surah: true,
        fromAyah: true,
        toAyah: true,
        createdAt: true,
        student: { select: { trackTemplate: { select: { name: true } } } },
      },
    });
    const reviewed = new Map<string, number[]>();
    for (const row of heard) {
      const track = row.student.trackTemplate?.name;
      const week = WEEKS_IN_CHART - 1 - Math.floor((now - row.createdAt.getTime()) / (7 * DAY_MS));
      if (!track || week < 0 || week >= WEEKS_IN_CHART) continue;
      const pages = (SURAH_PAGES[row.surah ?? 0] ?? []).filter(([, first, , last]) => first <= (row.toAyah ?? 0) && last >= (row.fromAyah ?? 0)).length;
      const weeks = reviewed.get(track) ?? blankWeeks();
      weeks[week] += pages;
      reviewed.set(track, weeks);
    }

    return [...new Set([...result.keys(), ...reviewed.keys()])].map((track) => ({
      track,
      memorized: result.get(track) ?? blankWeeks(),
      reviewed: reviewed.get(track) ?? blankWeeks(),
    }));
  }

  private inTeacherCircle(teacherId: string) {
    return { memberships: { some: { leftAt: null, circle: { teacherId, archivedAt: null } } } };
  }

  private async ownGate(teacher: StaffActor, gateId: string) {
    const gate = await this.prisma.surahGate.findFirst({
      where: { id: gateId, status: 'PENDING', student: this.inTeacherCircle(teacher.id) },
    });
    if (!gate) throw notFound();
    return gate;
  }
}
