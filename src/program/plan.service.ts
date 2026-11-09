import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { riyadhDate } from '../common/staff-api.js';
import { findSurah } from '../common/surahs.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { DailyUnit, GateMode, WirdSource } from '../generated/prisma/enums.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  buildUnits,
  buildWeek,
  computeProgress,
  convertCompletedUnits,
  DAY_MS,
  delayLabel,
  firstOpenStep,
  type PlanProgress,
  type PlanRules,
  type PlanUnit,
  unitLabel,
  wirdConfigOf,
} from './plan-engine.js';
import { NotificationsService } from './notifications.service.js';
import { SettingsService, type SettingValue } from './settings.service.js';

export type StudentPlanStatus = 'no_plan' | 'regular' | 'late' | 'awaiting_gate' | 'completed';

export interface PlanSummary extends PlanProgress {
  status: StudentPlanStatus;
  delay: string | null;
  /** The surah being memorized, or waiting at its gate. */
  currentSurah: number | null;
  /** What comes next, such as «الكهف · 54-57». */
  nextLabel: string | null;
  gateSurah: number | null;
  passedSurahs: number;
}

const NO_PLAN: PlanSummary = {
  status: 'no_plan',
  totalUnits: 0,
  completedUnits: 0,
  expectedUnits: 0,
  behindUnits: 0,
  behindPages: 0,
  behindDays: 0,
  commitment: null,
  progress: 0,
  delay: null,
  currentSurah: null,
  nextLabel: null,
  gateSurah: null,
  passedSurahs: 0,
};

const plusDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

interface GateContext {
  settings: SettingValue<'gate'>;
  mode: GateMode;
  exceptions: { type: string; expiresAt: Date | null }[];
  tasksTotal: number;
  tasksDone: number;
  /** Null until the administration publishes the surah's lesson. */
  content: { journaling: boolean } | null;
  reflected: boolean;
}

@Injectable()
export class PlanService {
  private readonly unitCache = new Map<string, PlanUnit[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Starts a student's plan on their track, once accepted, if they have a memorization track and no plan yet. */
  async startPlan(studentId: string): Promise<void> {
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      select: { admissionStatus: true, trackStart: true, trackTemplate: { select: { id: true, kind: true, surahOrder: true } } },
    });
    const template = student?.trackTemplate;
    if (student?.admissionStatus !== 'ACCEPTED' || template?.kind !== 'MEMORIZATION') return;

    // On the stabilization track a student may choose to begin at Al-Fatiha instead of Al-Kahf.
    const order = template.surahOrder;
    const from = student?.trackStart === 'FATIHA' ? Math.max(order.indexOf(1), 0) : 0;
    const surahOrder = [...order.slice(from), ...order.slice(0, from)];

    await this.prisma.studentPlan.createMany({
      data: [{ studentId, templateId: template.id, startOn: riyadhDate(), surahOrder }],
      skipDuplicates: true,
    });
  }

  /** Each student's standing, computed together so a list of any size runs a fixed number of queries. */
  async summaries(studentIds: string[]): Promise<Map<string, PlanSummary>> {
    const result = new Map<string, PlanSummary>(studentIds.map((id) => [id, NO_PLAN]));
    if (studentIds.length === 0) return result;

    const [plans, pending, passed] = await Promise.all([
      this.prisma.studentPlan.findMany({
        where: { studentId: { in: studentIds } },
        include: { template: { select: { dailyUnit: true, wirdDays: true, consolidationDays: true } } },
      }),
      this.prisma.surahGate.findMany({
        where: { studentId: { in: studentIds }, status: 'PENDING' },
        select: { studentId: true, surah: true, openedOn: true },
      }),
      this.prisma.surahGate.groupBy({
        by: ['studentId'],
        where: { studentId: { in: studentIds }, status: { in: ['PASSED', 'SKIPPED'] } },
        _count: true,
      }),
    ]);
    const pendingBy = new Map(pending.map((gate) => [gate.studentId, gate]));
    const passedBy = new Map(passed.map((row) => [row.studentId, row._count]));
    const today = riyadhDate();

    for (const plan of plans) {
      const rules = this.rulesOf(plan.template);
      if (!rules) continue;
      const units = this.unitsOf(rules.dailyUnit, plan.surahOrder);
      const gate = pendingBy.get(plan.studentId);
      const position = {
        startOn: plan.startOn,
        completedUnits: plan.completedUnits,
        creditedDays: plan.creditedDays,
        gateOpenedOn: gate?.openedOn ?? null,
      };
      const progress = computeProgress(units, rules, position, today);
      const next = units[plan.completedUnits] as PlanUnit | undefined;

      const status: StudentPlanStatus =
        plan.status === 'COMPLETED' && !gate ? 'completed' : gate ? 'awaiting_gate' : progress.behindUnits > 0 ? 'late' : 'regular';

      result.set(plan.studentId, {
        ...progress,
        status,
        delay: delayLabel(progress),
        currentSurah: gate?.surah ?? next?.surah ?? null,
        nextLabel: next ? unitLabel(next, rules.dailyUnit) : null,
        gateSurah: gate?.surah ?? null,
        passedSurahs: passedBy.get(plan.studentId) ?? 0,
      });
    }
    return result;
  }

  /** A student's week, for the app's plan screen and the teacher's profile page. */
  async weekFor(studentId: string) {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      include: { template: { select: { name: true, dailyUnit: true, wirdDays: true, consolidationDays: true } } },
    });
    const rules = plan && this.rulesOf(plan.template);
    if (!plan || !rules) return null;

    const today = riyadhDate();
    const gate = await this.prisma.surahGate.findFirst({ where: { studentId, status: 'PENDING' }, select: { openedOn: true } });
    const logs = await this.prisma.wirdLog.findMany({
      where: { planId: plan.id, doneOn: { gte: plusDays(today, -7) } },
      select: { doneOn: true },
    });
    const units = this.unitsOf(rules.dailyUnit, plan.surahOrder);
    return {
      trackName: plan.template.name,
      startOn: plan.startOn,
      days: buildWeek(
        units,
        rules,
        { startOn: plan.startOn, completedUnits: plan.completedUnits, creditedDays: plan.creditedDays, gateOpenedOn: gate?.openedOn ?? null },
        today,
        new Set(logs.map(({ doneOn }) => doneOn.toISOString().slice(0, 10))),
      ),
    };
  }

  /** Marks the next unit done. Refuses to pass a gate, or to count the same unit twice. */
  async completeNextUnit(studentId: string, source: WirdSource): Promise<void> {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      include: {
        template: { select: { gateMode: true, dailyUnit: true, wirdDays: true, consolidationDays: true, wirdSteps: true, repeatTarget: true, reviewTarget: true } },
      },
    });
    const rules = plan && this.rulesOf(plan.template);
    if (!plan || !rules) throw new ApiError(404, 'no_plan');
    if (plan.status === 'COMPLETED') throw new ApiError(409, 'plan_completed');

    const units = this.unitsOf(rules.dailyUnit, plan.surahOrder);
    const index = plan.completedUnits;
    const unit = units[index];
    if (index > 0 && units[index - 1].lastOfSurah) {
      const gate = await this.prisma.surahGate.findUnique({
        where: { studentId_surah: { studentId, surah: units[index - 1].surah } },
        select: { status: true },
      });
      if (gate?.status === 'PENDING') throw new ApiError(409, 'gate_pending');
    }
    // A teacher's recitation or an approved skip stands on its own. A student's own wird needs every step.
    if (source === 'STUDENT') {
      const progress = await this.prisma.wirdProgress.findUnique({
        where: { planId_unitIndex: { planId: plan.id, unitIndex: index } },
        select: { doneSteps: true, repeatCount: true, reviewCount: true },
      });
      const counts = { doneSteps: progress?.doneSteps ?? [], repeatCount: progress?.repeatCount ?? 0, reviewCount: progress?.reviewCount ?? 0 };
      if (firstOpenStep(counts, wirdConfigOf(plan.template), index > 0)) throw new ApiError(409, 'wird_steps_incomplete');
    }

    const today = riyadhDate();
    const gateSettings = await this.settings.get('gate');
    await this.prisma.$transaction(async (tx) => {
      // The index in the condition means two requests at once can't both advance past the same unit.
      const moved = await tx.studentPlan.updateMany({
        where: { id: plan.id, completedUnits: index, status: 'ACTIVE' },
        data: { completedUnits: index + 1, ...(index + 1 === units.length ? { status: 'COMPLETED', completedAt: new Date() } : {}) },
      });
      if (moved.count !== 1) throw new ApiError(409, 'already_done');

      await tx.wirdLog.create({ data: { planId: plan.id, unitIndex: index, source, doneOn: today } });

      if (unit.lastOfSurah && plan.template.gateMode !== 'PAUSED') {
        await tx.surahGate.createMany({
          data: [{ studentId, surah: unit.surah, openedOn: today, testDueOn: plusDays(today, gateSettings.examDelayDays) }],
          skipDuplicates: true,
        });
      }
    });

    if (unit.lastOfSurah && plan.template.gateMode !== 'PAUSED') {
      await this.notifications.notifyTeacherOf(studentId, {
        type: 'GENERAL',
        title: 'بوابة بانتظار الاعتماد',
        body: `أتمّت طالبة سورة ${findSurah(unit.surah)?.name ?? unit.surah}.`,
        dedupeKey: `gate-ready:${studentId}:${unit.surah}`,
      });
    }
    if (index + 1 === units.length) await this.awardBadge(studentId, 'quranCompanion');
  }

  /** A teacher's recitation counts as the work when it covers what comes next, and only then. */
  async advanceFromEvaluation(studentId: string, surah: number, fromAyah: number, toAyah: number): Promise<void> {
    for (;;) {
      const plan = await this.prisma.studentPlan.findUnique({
        where: { studentId },
        include: { template: { select: { dailyUnit: true, wirdDays: true, consolidationDays: true } } },
      });
      const rules = plan && this.rulesOf(plan.template);
      if (!plan || !rules || plan.status !== 'ACTIVE') return;

      const next = this.unitsOf(rules.dailyUnit, plan.surahOrder)[plan.completedUnits];
      if (next?.surah !== surah || next.fromAyah < fromAyah || next.toAyah > toAyah) return;

      try {
        await this.completeNextUnit(studentId, 'TEACHER');
      } catch (error) {
        // A gate or a simultaneous update just ends the advance. The recitation itself is already saved.
        if (error instanceof ApiError) return;
        throw error;
      }
    }
  }

  /** The gates' conditions, as the teacher and the student each need to see them. */
  async describeGates(gates: GateRow[]) {
    const settings = await this.settings.get('gate');
    const studentIds = [...new Set(gates.map((gate) => gate.studentId))];
    const surahs = [...new Set(gates.map((gate) => gate.surah))];
    const [plans, exceptions, tasks, completions, contents, reflections] = await Promise.all([
      this.prisma.studentPlan.findMany({
        where: { studentId: { in: studentIds } },
        select: { studentId: true, template: { select: { gateMode: true } } },
      }),
      this.prisma.gateException.findMany({
        where: { studentId: { in: studentIds }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { studentId: true, type: true, expiresAt: true },
      }),
      this.prisma.tadabburTask.findMany({
        where: { surah: { in: surahs }, content: { published: true } },
        select: { id: true, surah: true },
      }),
      this.prisma.practicalCompletion.findMany({
        where: { studentId: { in: studentIds }, task: { surah: { in: surahs } } },
        select: { studentId: true, task: { select: { surah: true } } },
      }),
      this.prisma.surahTadabbur.findMany({
        where: { surah: { in: surahs }, published: true },
        select: { surah: true, journaling: true },
      }),
      this.prisma.tadabburReflection.findMany({
        where: { studentId: { in: studentIds }, surah: { in: surahs } },
        select: { studentId: true, surah: true },
      }),
    ]);

    return gates.map((gate) =>
      this.describeGate(gate, {
        settings,
        mode: plans.find((plan) => plan.studentId === gate.studentId)?.template.gateMode ?? 'ACTIVE',
        exceptions: exceptions.filter((item) => item.studentId === gate.studentId),
        tasksTotal: tasks.filter((task) => task.surah === gate.surah).length,
        tasksDone: completions.filter((item) => item.studentId === gate.studentId && item.task.surah === gate.surah).length,
        content: contents.find((item) => item.surah === gate.surah) ?? null,
        reflected: reflections.some((item) => item.studentId === gate.studentId && item.surah === gate.surah),
      }),
    );
  }

  /** Passing opens the next surah. Waiting days are credited, so the wait doesn't count as falling behind. */
  async approveGate(actor: StaffActor, gate: GateRow, score: number | null): Promise<void> {
    const [described] = await this.describeGates([gate]);
    if (!described.conditionsMet) throw new ApiError(409, 'gate_conditions_unmet');
    if (described.lesson.required && !described.lesson.confirmedAt) throw new ApiError(409, 'lesson_not_confirmed');

    if (described.exam.required) {
      if (!described.exam.due) throw new ApiError(409, 'exam_not_due');
      if (score === null) throw new ApiError(400, 'score_required');
      if (score < described.exam.passScore) throw new ApiError(409, 'score_below_pass');
    }
    await this.closeGate(gate, 'PASSED', actor, score);
    await this.awardBadge(gate.studentId, 'surahComplete');
    await this.audit.record(actor, 'gate.approve', { type: 'student', id: gate.studentId }, { surah: gate.surah, score });
  }

  /** The student repeats the wrap and the test. The gate stays open with a new test date. */
  async returnGate(actor: StaffActor, gate: GateRow, note: string | null): Promise<void> {
    const { examDelayDays } = await this.settings.get('gate');
    const { count } = await this.prisma.surahGate.updateMany({
      where: { id: gate.id, status: 'PENDING' },
      data: { wrapCount: 0, returnNote: note, testDueOn: plusDays(riyadhDate(), examDelayDays) },
    });
    if (count !== 1) throw new ApiError(409, 'invalid_gate_state');
    await this.audit.record(actor, 'gate.return', { type: 'student', id: gate.studentId }, { surah: gate.surah });
  }

  /** Moves a student past their current surah after an approved request, marking its units as skipped. */
  async skipCurrentSurah(actor: StaffActor, studentId: string, surah: number): Promise<void> {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      include: { template: { select: { dailyUnit: true, wirdDays: true, consolidationDays: true } } },
    });
    const rules = plan && this.rulesOf(plan.template);
    if (!plan || !rules) throw new ApiError(404, 'no_plan');

    const units = this.unitsOf(rules.dailyUnit, plan.surahOrder);
    const remaining = units.slice(plan.completedUnits).filter((unit) => unit.surah === surah);
    const today = riyadhDate();

    if (remaining.length > 0) {
      if (units[plan.completedUnits].surah !== surah) throw new ApiError(409, 'not_current_surah');
      const end = remaining.at(-1)!.index + 1;
      await this.prisma.$transaction(async (tx) => {
        const moved = await tx.studentPlan.updateMany({
          where: { id: plan.id, completedUnits: plan.completedUnits },
          data: { completedUnits: end, ...(end === units.length ? { status: 'COMPLETED', completedAt: new Date() } : {}) },
        });
        if (moved.count !== 1) throw new ApiError(409, 'already_done');
        await tx.wirdLog.createMany({
          data: remaining.map((unit) => ({ planId: plan.id, unitIndex: unit.index, source: 'SKIP' as const, doneOn: today })),
        });
        await tx.surahGate.upsert({
          where: { studentId_surah: { studentId, surah } },
          create: { studentId, surah, status: 'SKIPPED', openedOn: today, testDueOn: today, decidedById: actor.id, decidedAt: new Date() },
          update: { status: 'SKIPPED', decidedById: actor.id, decidedAt: new Date() },
        });
      });
      return;
    }

    // The surah is finished and waiting at its gate.
    const gate = await this.prisma.surahGate.findUnique({ where: { studentId_surah: { studentId, surah } } });
    if (gate?.status !== 'PENDING') throw new ApiError(409, 'not_current_surah');
    await this.closeGate(gate, 'SKIPPED', actor, null);
  }

  private async closeGate(gate: GateRow, status: 'PASSED' | 'SKIPPED', actor: StaffActor, score: number | null): Promise<void> {
    const today = riyadhDate();
    const waited = Math.max(0, Math.round((today.getTime() - gate.openedOn.getTime()) / DAY_MS));
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.surahGate.updateMany({
        where: { id: gate.id, status: 'PENDING' },
        data: { status, score, decidedById: actor.id, decidedAt: new Date() },
      });
      if (count !== 1) throw new ApiError(409, 'invalid_gate_state');
      await tx.studentPlan.updateMany({ where: { studentId: gate.studentId }, data: { creditedDays: { increment: waited } } });
    });
  }

  /**
   * A new daily amount applies to everyone on the track. Each plan keeps exactly what was memorized, recounted
   * in the new units. Steps in progress belong to a unit, so they start over.
   */
  async changeDailyUnit(templateId: string, from: DailyUnit, to: DailyUnit, tx: Prisma.TransactionClient): Promise<void> {
    const plans = await tx.studentPlan.findMany({
      where: { templateId },
      select: {
        id: true,
        completedUnits: true,
        completedAt: true,
        surahOrder: true,
        logs: { orderBy: { createdAt: 'asc' }, select: { unitIndex: true, source: true, doneOn: true, createdAt: true } },
      },
    });
    for (const plan of plans) {
      const before = this.unitsOf(from, plan.surahOrder);
      const after = this.unitsOf(to, plan.surahOrder);
      const logs = new Map<number, (typeof plan.logs)[number]>();
      for (const log of plan.logs) {
        const unitIndex = convertCompletedUnits(before, after, log.unitIndex + 1) - 1;
        if (unitIndex >= 0) logs.set(unitIndex, log);
      }
      const completedUnits = convertCompletedUnits(before, after, plan.completedUnits);

      await tx.wirdProgress.deleteMany({ where: { planId: plan.id } });
      await tx.wirdLog.deleteMany({ where: { planId: plan.id } });
      await tx.wirdLog.createMany({
        data: [...logs].map(([unitIndex, log]) => ({ ...log, planId: plan.id, unitIndex })),
      });
      const completed = completedUnits >= after.length;
      await tx.studentPlan.update({
        where: { id: plan.id },
        data: {
          completedUnits,
          status: completed ? 'COMPLETED' : 'ACTIVE',
          completedAt: completed ? (plan.completedAt ?? new Date()) : null,
        },
      });
    }
  }

  async awardBadge(studentId: string, code: string, awardedById?: string): Promise<void> {
    const badge = await this.prisma.badge.findUnique({ where: { code }, select: { id: true } });
    if (!badge) return;
    await this.prisma.studentBadge.createMany({
      data: [{ studentId, badgeId: badge.id, awardedById }],
      skipDuplicates: true,
    });
  }

  private describeGate(gate: GateRow, context: GateContext) {
    const active = (type: string) => context.exceptions.some((item) => item.type === type);
    const mode = active('RELAXED_GATE') && context.mode === 'ACTIVE' ? 'RELAXED' : context.mode;
    const full = mode === 'ACTIVE';
    const relaxed = mode === 'RELAXED';

    const tafsirRequired = (full || relaxed) && context.settings.tafsir && !active('SKIP_TAFSIR');
    const practicalRequired = (full || relaxed) && context.tasksTotal > 0;
    const lessonRequired = (full || relaxed) && context.content !== null;
    // Writing what they took from the surah is the heart of the gate, so it stands even before a lesson is published.
    const reflectionRequired = (full || relaxed) && (context.content?.journaling ?? true);
    const wrapRequired = full && context.settings.wrap && !active('SKIP_WRAP');
    // A teacher-led gate is decided by the teacher's score, with no waiting period.
    const examRequired = mode === 'TEACHER' || (full && context.settings.exam);

    const today = riyadhDate();
    const postponedTo = context.exceptions.find((item) => item.type === 'POSTPONE_EXAM')?.expiresAt ?? null;
    const dueOn = mode === 'TEACHER' ? gate.openedOn : postponedTo && postponedTo > gate.testDueOn ? postponedTo : gate.testDueOn;

    const conditionsMet =
      (!tafsirRequired || gate.tafsirDoneAt !== null) &&
      (!lessonRequired || gate.lessonAttendedAt !== null) &&
      (!reflectionRequired || context.reflected) &&
      (!practicalRequired || context.tasksDone >= context.tasksTotal) &&
      (!wrapRequired || gate.wrapCount >= context.settings.wrapCount);

    return {
      id: gate.id,
      studentId: gate.studentId,
      surah: gate.surah,
      surahName: findSurah(gate.surah)?.name ?? null,
      status: gate.status,
      openedOn: gate.openedOn,
      returnNote: gate.returnNote,
      score: gate.score === null ? null : Number(gate.score),
      mode,
      tafsir: { required: tafsirRequired, doneAt: gate.tafsirDoneAt },
      lesson: { required: lessonRequired, doneAt: gate.lessonAttendedAt, confirmedAt: gate.lessonConfirmedAt },
      reflection: { required: reflectionRequired, done: context.reflected },
      practical: { required: practicalRequired, done: context.tasksDone, total: context.tasksTotal },
      wrap: { required: wrapRequired, count: gate.wrapCount, needed: context.settings.wrapCount },
      exam: { required: examRequired, dueOn, due: dueOn <= today, passScore: context.settings.passScore },
      conditionsMet,
      /** The teacher can enter the score and approve now. */
      readyForDecision: conditionsMet && (!lessonRequired || gate.lessonConfirmedAt !== null) && (!examRequired || dueOn <= today),
    };
  }

  private rulesOf(template: { dailyUnit: DailyUnit | null; wirdDays: number[]; consolidationDays: number }): PlanRules | null {
    return template.dailyUnit
      ? { dailyUnit: template.dailyUnit, wirdDays: template.wirdDays, consolidationDays: template.consolidationDays }
      : null;
  }

  private unitsOf(dailyUnit: DailyUnit, surahOrder: number[]): PlanUnit[] {
    const key = `${dailyUnit}:${surahOrder.join(',')}`;
    let units = this.unitCache.get(key);
    if (!units) {
      units = buildUnits(dailyUnit, surahOrder);
      this.unitCache.set(key, units);
    }
    return units;
  }
}

export interface GateRow {
  id: string;
  studentId: string;
  surah: number;
  status: string;
  openedOn: Date;
  testDueOn: Date;
  tafsirDoneAt: Date | null;
  lessonAttendedAt: Date | null;
  lessonConfirmedAt: Date | null;
  wrapCount: number;
  score: { toString(): string } | null;
  returnNote: string | null;
}
