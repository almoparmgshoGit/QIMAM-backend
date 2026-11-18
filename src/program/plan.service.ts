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
  type DailyAmount,
  DAY_MS,
  delayLabel,
  dueUnitsToday,
  firstOpenStep,
  type SessionEvent,
  sessionEventFinishes,
  sessionsOf,
  stepOptions,
  type PlanProgress,
  type PlanRules,
  type PlanUnit,
  unitLabel,
  wirdConfigOf,
  wirdCountsOf,
} from './plan-engine.js';
import { type BadgeMetrics, badgeReached, EMPTY_METRICS } from './badge-rules.js';
import { reviewEndsOnFor } from './review-rules.js';
import { pageRangeFor } from './scope.js';
import { NotificationsService } from './notifications.service.js';
import { SettingsService, type SettingValue } from './settings.service.js';
import { StageExamService } from './stage-exam.service.js';

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
    private readonly stageExams: StageExamService,
  ) {}

  /** Starts a student's plan on their track, once accepted, if they have a memorization track and no plan yet. */
  async startPlan(studentId: string): Promise<void> {
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      select: {
        admissionStatus: true,
        trackStart: true,
        trackTemplate: { select: { id: true, kind: true, surahOrder: true, juzFrom: true, juzTo: true, durationMonths: true } },
      },
    });
    const template = student?.trackTemplate;
    // A review track runs a plan as memorization does. A correction track has none.
    if (student?.admissionStatus !== 'ACCEPTED' || !template || template.kind === 'CORRECTION') return;

    // On the stabilization track a student chooses to begin at Al-Kahf or at Al-Fatiha. The plan goes round from there
    // in the track's own order. A surah outside the track's scope leaves the plan at the track's own start.
    const order = template.surahOrder;
    const startSurah = student?.trackStart === 'KAHF' ? 18 : student?.trackStart === 'FATIHA' ? 1 : null;
    const from = startSurah === null ? 0 : Math.max(order.indexOf(startSurah), 0);
    const surahOrder = [...order.slice(from), ...order.slice(0, from)];

    const startOn = riyadhDate();
    await this.prisma.studentPlan.createMany({
      data: [
        {
          studentId,
          templateId: template.id,
          startOn,
          surahOrder,
          pageRange: pageRangeFor(template.juzFrom, template.juzTo),
          reviewEndsOn: template.kind === 'REVIEW' ? reviewEndsOnFor(startOn, template.durationMonths) : null,
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * A new track or starting point begins the plan again: the old plan, its logs and any gate still waiting go.
   * With `startNow` the new plan begins at once; otherwise it begins when the student joins a circle.
   */
  async restartPlan(studentId: string, startNow: boolean): Promise<void> {
    await this.prisma.$transaction([
      // The logs and daily progress go with the plan.
      this.prisma.studentPlan.deleteMany({ where: { studentId } }),
      this.prisma.surahGate.deleteMany({ where: { studentId, status: 'PENDING' } }),
    ]);
    if (startNow) await this.startPlan(studentId);
  }

  /** Each student's standing, computed together so a list of any size runs a fixed number of queries. */
  async summaries(studentIds: string[]): Promise<Map<string, PlanSummary>> {
    const result = new Map<string, PlanSummary>(studentIds.map((id) => [id, NO_PLAN]));
    if (studentIds.length === 0) return result;

    const [plans, pending, passed] = await Promise.all([
      this.prisma.studentPlan.findMany({
        where: { studentId: { in: studentIds } },
        include: { template: { select: { dailyUnit: true, dailyAyahs: true, wirdDays: true, consolidationDays: true } } },
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
      const units = this.unitsOf(rules, plan);
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
      include: { template: { select: { name: true, dailyUnit: true, dailyAyahs: true, wirdDays: true, consolidationDays: true } } },
    });
    const rules = plan && this.rulesOf(plan.template);
    if (!plan || !rules) return null;

    const today = riyadhDate();
    const gate = await this.prisma.surahGate.findFirst({ where: { studentId, status: 'PENDING' }, select: { openedOn: true } });
    const logs = await this.prisma.wirdLog.findMany({
      where: { planId: plan.id, doneOn: { gte: plusDays(today, -7) } },
      select: { doneOn: true },
    });
    const units = this.unitsOf(rules, plan);
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

  /**
   * The unit the student finished herself today once today's wird is done, or null while it isn't. The wird is
   * daily, and a missed wird day carries over: today's wird is every portion due up to today, so the day is done
   * only once she has caught up. With nothing owed she may still do one portion ahead, and the next opens tomorrow.
   * A teacher's recitation or an approved skip doesn't use up her day, though it does count toward what is owed.
   */
  async ownWirdToday(planId: string): Promise<number | null> {
    return (await this.todayWird(planId)).doneUnit;
  }

  /** Today's wird: how many portions it holds, how many are done, and the last one she finished once it is done. */
  async todayWird(planId: string): Promise<{ doneUnit: number | null; total: number; done: number }> {
    const today = riyadhDate();
    const [plan, logs] = await Promise.all([
      this.prisma.studentPlan.findUnique({
        where: { id: planId },
        include: { template: { select: { dailyUnit: true, dailyAyahs: true, wirdDays: true, consolidationDays: true } } },
      }),
      this.prisma.wirdLog.findMany({ where: { planId, doneOn: today }, orderBy: { unitIndex: 'desc' }, select: { unitIndex: true, source: true } }),
    ]);
    const rules = plan && this.rulesOf(plan.template);
    const own = logs.find(({ source }) => source === 'STUDENT');
    if (!plan || !rules) return { doneUnit: own?.unitIndex ?? null, total: logs.length, done: logs.length };

    const gate = await this.prisma.surahGate.findFirst({ where: { studentId: plan.studentId, status: 'PENDING' }, select: { openedOn: true } });
    const units = this.unitsOf(rules, plan);
    const due = dueUnitsToday(
      units,
      rules,
      { startOn: plan.startOn, completedUnits: plan.completedUnits, creditedDays: plan.creditedDays, gateOpenedOn: gate?.openedOn ?? null },
      today,
    );
    const owed = Math.max(0, due - plan.completedUnits);
    const finished = plan.status === 'COMPLETED' || (own !== undefined && owed === 0);
    // Nothing owed and nothing done yet still leaves one portion to do today.
    const remaining = finished ? 0 : Math.max(1, owed);
    return { doneUnit: finished ? (own?.unitIndex ?? null) : null, total: logs.length + remaining, done: logs.length };
  }

  /**
   * Ticks the wird's session step for the portion the student is working on, when what the teacher did is
   * what the track asks of it: the voice session ending, or the recitation evaluated (or marked mastered),
   * heard the way the track recites. Nothing changes once today's wird is done, since the next portion hasn't
   * been started yet.
   */
  async markSessionStep(studentId: string, event: SessionEvent): Promise<void> {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      select: { id: true, status: true, completedUnits: true, template: { select: { wirdSteps: true, recitationMode: true, repeatTarget: true, reviewTarget: true, listenTarget: true } } },
    });
    if (!plan || plan.status !== 'ACTIVE') return;
    const config = wirdConfigOf(plan.template);
    const step = config.steps.find(({ kind }) => kind === 'SESSION');
    if (!step || !sessionEventFinishes(stepOptions(step).completion, event, config.recitationMode)) return;
    if ((await this.ownWirdToday(plan.id)) !== null) return;

    const key = { planId: plan.id, unitIndex: plan.completedUnits };
    const row = await this.prisma.wirdProgress.findUnique({ where: { planId_unitIndex: key }, select: { doneSteps: true } });
    if (row?.doneSteps.includes(step.id)) return;
    await this.prisma.wirdProgress.upsert({
      where: { planId_unitIndex: key },
      create: { ...key, doneSteps: [step.id] },
      update: { doneSteps: { push: step.id } },
    });
  }

  /** Marks the next unit done. Refuses to pass a gate, or to count the same unit twice. */
  async completeNextUnit(studentId: string, source: WirdSource): Promise<void> {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      include: {
        template: { select: { gateMode: true, stageExamMode: true, dailyUnit: true, dailyAyahs: true, dailySessions: true, wirdDays: true, consolidationDays: true, wirdSteps: true, recitationMode: true, repeatTarget: true, reviewTarget: true, listenTarget: true } },
      },
    });
    const rules = plan && this.rulesOf(plan.template);
    if (!plan || !rules) throw new ApiError(404, 'no_plan');
    if (plan.status === 'COMPLETED') throw new ApiError(409, 'plan_completed');

    const units = this.unitsOf(rules, plan);
    const index = plan.completedUnits;
    const unit = units[index];
    if (index > 0 && units[index - 1].lastOfSurah) {
      const gate = await this.prisma.surahGate.findUnique({
        where: { studentId_surah: { studentId, surah: units[index - 1].surah } },
        select: { status: true },
      });
      if (gate?.status === 'PENDING') throw new ApiError(409, 'gate_pending');
    }
    // A track may hold new memorization until the last seventh finished is tested.
    if (await this.stageExams.holdsBack(studentId, plan.template.stageExamMode)) throw new ApiError(409, 'stage_exam_pending');
    // A teacher's recitation or an approved skip stands on its own. A student's own wird needs every step.
    if (source === 'STUDENT') {
      if ((await this.ownWirdToday(plan.id)) !== null) throw new ApiError(409, 'wird_done_today');
      const progress = await this.prisma.wirdProgress.findUnique({
        where: { planId_unitIndex: { planId: plan.id, unitIndex: index } },
        select: { doneSteps: true, repeatCount: true, reviewCount: true, listenCount: true, doneSessions: true },
      });
      const counts = wirdCountsOf(progress);
      if (firstOpenStep(counts, wirdConfigOf(plan.template), index > 0)) throw new ApiError(409, 'wird_steps_incomplete');
      // A day split into sessions is done once every session is.
      const sessions = sessionsOf(unit, plan.template.dailySessions);
      if (sessions.some(({ number }) => !progress?.doneSessions.includes(number))) throw new ApiError(409, 'wird_sessions_incomplete');
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
        body: `{{أتمّ طالب|أتمّت طالبة}} سورة ${findSurah(unit.surah)?.name ?? unit.surah}.`,
        dedupeKey: `gate-ready:${studentId}:${unit.surah}`,
      });
    }
    await this.stageExams.onProgress(studentId, units, index, index + 1, plan.template.stageExamMode);
    await this.awardEarnedBadges(studentId);
  }

  /** A teacher's recitation counts as the work when it covers what comes next, and only then. */
  async advanceFromEvaluation(studentId: string, surah: number, fromAyah: number, toAyah: number): Promise<void> {
    for (;;) {
      const plan = await this.prisma.studentPlan.findUnique({
        where: { studentId },
        include: { template: { select: { dailyUnit: true, dailyAyahs: true, wirdDays: true, consolidationDays: true } } },
      });
      const rules = plan && this.rulesOf(plan.template);
      if (!plan || !rules || plan.status !== 'ACTIVE') return;

      const next = this.unitsOf(rules, plan)[plan.completedUnits];
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
    await this.awardEarnedBadges(gate.studentId);
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
      include: { template: { select: { dailyUnit: true, dailyAyahs: true, wirdDays: true, consolidationDays: true, stageExamMode: true } } },
    });
    const rules = plan && this.rulesOf(plan.template);
    if (!plan || !rules) throw new ApiError(404, 'no_plan');

    const units = this.unitsOf(rules, plan);
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
      // A skipped surah still finishes its seventh, which is tested like any other.
      await this.stageExams.onProgress(studentId, units, plan.completedUnits, end, plan.template.stageExamMode);
      return;
    }

    // The surah is finished and waiting at its gate.
    const gate = await this.prisma.surahGate.findUnique({ where: { studentId_surah: { studentId, surah } } });
    if (gate?.status !== 'PENDING') throw new ApiError(409, 'not_current_surah');
    await this.closeGate(gate, 'SKIPPED', actor, null);
  }

  /** The surahs a teacher can send the student back to: those begun before where the student is now. */
  async rewindableSurahs(studentId: string): Promise<number[]> {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      include: { template: { select: { dailyUnit: true, dailyAyahs: true, wirdDays: true, consolidationDays: true } } },
    });
    const rules = plan && this.rulesOf(plan.template);
    if (!plan || !rules) return [];
    return [...new Set(this.unitsOf(rules, plan).slice(0, plan.completedUnits).map(({ surah }) => surah))];
  }

  /**
   * Sends the student back to the start of a surah already memorized, to memorize it and what follows again.
   * The work from there on is undone, with its gates. The days it took are credited, so going back is the
   * teacher's decision and doesn't show as the student falling behind.
   */
  async rewindToSurah(actor: StaffActor, studentId: string, surah: number): Promise<void> {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      include: { template: { select: { dailyUnit: true, dailyAyahs: true, wirdDays: true, consolidationDays: true } } },
    });
    const rules = plan && this.rulesOf(plan.template);
    if (!plan || !rules) throw new ApiError(404, 'no_plan');

    const units = this.unitsOf(rules, plan);
    const from = units.findIndex((unit) => unit.surah === surah);
    if (from === -1 || from >= plan.completedUnits) throw new ApiError(409, 'not_before_current');

    const undone = units.slice(from, plan.completedUnits);
    const surahs = [...new Set(undone.map((unit) => unit.surah))];
    // Each unit is a wird day, and the week has only its wird days, so this many calendar days cover them.
    const credit = Math.ceil((undone.length * 7) / Math.max(1, rules.wirdDays.length));

    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.studentPlan.updateMany({
        where: { id: plan.id, completedUnits: plan.completedUnits },
        data: { completedUnits: from, status: 'ACTIVE', completedAt: null, creditedDays: { increment: credit } },
      });
      if (moved.count !== 1) throw new ApiError(409, 'already_done');
      await tx.wirdLog.deleteMany({ where: { planId: plan.id, unitIndex: { gte: from } } });
      await tx.wirdProgress.deleteMany({ where: { planId: plan.id, unitIndex: { gte: from } } });
      await tx.surahGate.deleteMany({ where: { studentId, surah: { in: surahs } } });
    });
    await this.audit.record(actor, 'plan.rewind', { type: 'student', id: studentId }, { surah, units: undone.length });
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
  async changeDailyUnit(templateId: string, from: DailyAmount, to: DailyAmount, tx: Prisma.TransactionClient): Promise<void> {
    const plans = await tx.studentPlan.findMany({
      where: { templateId },
      select: {
        id: true,
        completedUnits: true,
        completedAt: true,
        surahOrder: true,
        pageRange: true,
        logs: { orderBy: { createdAt: 'asc' }, select: { unitIndex: true, source: true, doneOn: true, createdAt: true } },
      },
    });
    for (const plan of plans) {
      const before = this.unitsOf(from, plan);
      const after = this.unitsOf(to, plan);
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

  /** What automatic badges count for this student. */
  async badgeMetrics(studentId: string): Promise<BadgeMetrics> {
    const [plan, surahsPassed] = await Promise.all([
      this.prisma.studentPlan.findUnique({
        where: { studentId },
        include: { template: { select: { dailyUnit: true, dailyAyahs: true, wirdDays: true, consolidationDays: true } } },
      }),
      this.prisma.surahGate.count({ where: { studentId, status: 'PASSED' } }),
    ]);
    const rules = plan && this.rulesOf(plan.template);
    if (!plan || !rules) return { ...EMPTY_METRICS, surahsPassed };

    const units = this.unitsOf(rules, plan);
    const logs = await this.prisma.wirdLog.findMany({
      where: { planId: plan.id, source: { not: 'SKIP' } },
      select: { unitIndex: true, doneOn: true },
    });
    return {
      surahsPassed,
      pages: logs.reduce((sum, { unitIndex }) => sum + (units[unitIndex]?.pages ?? 0), 0),
      wirdDays: new Set(logs.map(({ doneOn }) => doneOn.toISOString().slice(0, 10))).size,
      trackProgress: units.length > 0 ? Math.round((plan.completedUnits / units.length) * 100) : 0,
      trackCompleted: plan.status === 'COMPLETED',
    };
  }

  /** Gives the student every active automatic badge she has now reached, and tells her about each. */
  async awardEarnedBadges(studentId: string): Promise<void> {
    const candidates = await this.prisma.badge.findMany({
      where: { active: true, trigger: { not: 'MANUAL' }, audience: { in: ['STUDENTS', 'EVERYONE'] }, awards: { none: { studentId } } },
      select: { id: true, label: true, trigger: true, threshold: true },
    });
    if (candidates.length === 0) return;

    const metrics = await this.badgeMetrics(studentId);
    for (const badge of candidates) {
      if (!badgeReached(badge.trigger, badge.threshold, metrics)) continue;
      const { count } = await this.prisma.studentBadge.createMany({ data: [{ studentId, badgeId: badge.id }], skipDuplicates: true });
      if (count === 1) {
        await this.notifications.send([studentId], { type: 'BADGES', title: 'شارة جديدة', body: badge.label, dedupeKey: `badge:${badge.id}` });
      }
    }
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

  private rulesOf(template: { dailyUnit: DailyUnit | null; dailyAyahs: number | null; wirdDays: number[]; consolidationDays: number }): PlanRules | null {
    return template.dailyUnit
      ? { dailyUnit: template.dailyUnit, dailyAyahs: template.dailyAyahs, wirdDays: template.wirdDays, consolidationDays: template.consolidationDays }
      : null;
  }

  private unitsOf({ dailyUnit, dailyAyahs }: DailyAmount, { surahOrder, pageRange }: { surahOrder: number[]; pageRange: number[] }): PlanUnit[] {
    const key = `${dailyUnit}:${dailyAyahs ?? ''}:${surahOrder.join(',')}:${pageRange.join('-')}`;
    let units = this.unitCache.get(key);
    if (!units) {
      units = buildUnits(dailyUnit, surahOrder, pageRange, dailyAyahs);
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
