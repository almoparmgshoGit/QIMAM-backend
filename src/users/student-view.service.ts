import { Injectable } from '@nestjs/common';
import { BadgesService } from '../badges/badges.service.js';
import { ApiError } from '../common/api-error.js';
import { ATTENDANCE_DAY, riyadhDate } from '../common/staff-api.js';
import { findSurah } from '../common/surahs.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  absenceLevel,
  buildUnits,
  buildWeek,
  computeStreak,
  dailyUnitLabel,
  DAY_MS,
  firstOpenStep,
  isStepDone,
  nextSegmentReview,
  projectFinish,
  canSelfMark,
  reviewRange,
  sessionName,
  sessionsOf,
  stepOptions,
  unitLabel,
  wirdConfigOf,
  wirdCountsOf,
} from '../program/plan-engine.js';
import { scopeLabel } from '../program/scope.js';
import { PlanService } from '../program/plan.service.js';
import { SettingsService } from '../program/settings.service.js';

const timesLabel = (count: number) => (count === 1 ? 'مرة واحدة' : count === 2 ? 'مرتان' : count <= 10 ? `${count} مرات` : `${count} مرة`);

/** What a session step says it waits for, when its track wrote nothing of its own. */
const SESSION_SUBTITLES = {
  ATTENDED: 'تُحتسب بانتهاء الجلسة الصوتية مع المعلمة',
  EVALUATED: 'تُحتسب حين تقيّم المعلمة تسميعك',
  MASTERED: 'تُحتسب حين تعتمد المعلمة إتقان النصاب',
} as const;

/** The same on a track that recites by recording, which has no session to attend. */
const RECORDING_SUBTITLES = {
  ATTENDED: 'سجّلي تسميعك وأرسليه، وتُحتسب حين تقيّمه المعلمة',
  EVALUATED: 'سجّلي تسميعك وأرسليه، وتُحتسب حين تقيّمه المعلمة',
  MASTERED: 'سجّلي تسميعك وأرسليه، وتُحتسب حين تعتمد المعلمة إتقانه',
} as const;

const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const iso = (date: Date) => date.toISOString().slice(0, 10);
const plusDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

/** Everything the app's own screens show. Each query is limited to the signed-in student. */
@Injectable()
export class StudentViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly settings: SettingsService,
    private readonly badgeService: BadgesService,
  ) {}

  async dashboard(studentId: string) {
    // Students who signed up, or were added by the administration, before they had a plan get one now.
    await this.plans.startPlan(studentId);
    const [plan, circle, announcement, segments] = await Promise.all([
      this.planView(studentId),
      this.circleSummary(studentId),
      this.latestAnnouncement(studentId),
      this.reviewSegments(studentId),
    ]);
    return { plan, circle, announcement, reviewSegments: segments };
  }

  private async planView(studentId: string) {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      include: {
        template: {
          select: { name: true, dailyUnit: true, dailyAyahs: true, dailySessions: true, wirdDays: true, consolidationDays: true, wirdSteps: true, recitationMode: true, repeatTarget: true, reviewTarget: true, listenTarget: true, encouragements: true },
        },
        logs: { orderBy: { doneOn: 'desc' }, take: 800, select: { doneOn: true, unitIndex: true } },
      },
    });
    if (!plan?.template.dailyUnit) return null;

    const rules = {
      dailyUnit: plan.template.dailyUnit,
      dailyAyahs: plan.template.dailyAyahs,
      wirdDays: plan.template.wirdDays,
      consolidationDays: plan.template.consolidationDays,
    };
    const today = riyadhDate();
    const units = buildUnits(rules.dailyUnit, plan.surahOrder, plan.pageRange, rules.dailyAyahs);
    const [summaries, gateRows] = await Promise.all([
      this.plans.summaries([studentId]),
      this.prisma.surahGate.findMany({ where: { studentId, status: 'PENDING' } }),
    ]);
    const summary = summaries.get(studentId)!;
    const [gate] = await this.plans.describeGates(gateRows);
    const doneDates = new Set(plan.logs.map(({ doneOn }) => iso(doneOn)));
    const position = {
      startOn: plan.startOn,
      completedUnits: plan.completedUnits,
      creditedDays: plan.creditedDays,
      gateOpenedOn: gateRows[0]?.openedOn ?? null,
    };
    const week = buildWeek(units, rules, position, today, doneDates);
    const finish = projectFinish(units, rules, plan.completedUnits, today);
    // Once she has done today's wird, the day shows it finished, and the next unit opens tomorrow.
    // A missed day carries over, so today's wird can hold several portions, done one after another.
    const todayWird = await this.plans.todayWird(plan.id);
    const doneToday = todayWird.doneUnit;
    const shownIndex = doneToday ?? plan.completedUnits;
    const next = units[shownIndex] as (typeof units)[number] | undefined;

    const progressRow = next
      ? await this.prisma.wirdProgress.findUnique({ where: { planId_unitIndex: { planId: plan.id, unitIndex: next.index } } })
      : null;
    const counts = wirdCountsOf(progressRow);
    const config = wirdConfigOf(plan.template);
    // The review step can go over several portions before today's, as the track sets.
    const reviewStep = config.steps.find(({ kind }) => kind === 'REVIEW');
    const reviewed = reviewRange(units, shownIndex, stepOptions(reviewStep).portions);
    const previous = reviewed.length > 0 ? { ...reviewed[0], toAyah: reviewed.at(-1)!.toAyah, count: reviewed.length } : undefined;
    const sessionStep = config.steps.find(({ kind }) => kind === 'SESSION');
    // The voice session she can join for the session step: one for her alone, running now or coming up today.
    const liveSession =
      sessionStep && config.recitationMode === 'LIVE' && next && doneToday === null
        ? await this.prisma.liveSession.findFirst({
            where: {
              studentId,
              kind: 'RECITATION',
              status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
              scheduledAt: { gte: new Date(Date.now() - 3 * 60 * 60 * 1000), lt: plusDays(today, 2) },
            },
            orderBy: [{ status: 'desc' }, { scheduledAt: 'asc' }],
            select: { id: true, title: true, status: true, scheduledAt: true },
          })
        : null;
    const stepSubtitle = (step: (typeof config.steps)[number]) => {
      if (step.kind === 'REVIEW' && !previous) return 'لا يوجد نصيب سابق بعد';
      if (step.subtitle) return step.subtitle;
      if (step.kind === 'REVIEW') return timesLabel(config.reviewTarget);
      if (step.kind === 'LISTEN') return config.listenTarget > 1 ? timesLabel(config.listenTarget) : '';
      if (step.kind === 'SESSION') {
        return (config.recitationMode === 'RECORDING' ? RECORDING_SUBTITLES : SESSION_SUBTITLES)[stepOptions(step).completion];
      }
      return step.kind === 'REPEAT' ? timesLabel(config.repeatTarget) : '';
    };

    const todayKey = iso(today);
    const dayKinds = await this.prisma.dayCompletion.findMany({ where: { studentId, doneOn: today }, select: { kind: true } });
    const weekStart = week[0].date;
    const logsThisWeek = plan.logs.filter(({ doneOn }) => iso(doneOn) >= weekStart);
    const wirdThisWeek = week.filter((day) => rules.wirdDays.includes(day.weekday));

    return {
      trackName: plan.template.name,
      rule: `${dailyUnitLabel(rules.dailyUnit, rules.dailyAyahs)} · ${formatDays(rules.wirdDays)}`,
      status: summary.status,
      progress: summary.progress,
      commitment: summary.commitment,
      delay: summary.delay,
      passedSurahs: summary.passedSurahs,
      remainingDays: finish?.remainingDays ?? null,
      finishOn: finish?.finishOn ?? null,
      streak: computeStreak(doneDates, rules.wirdDays, today),
      weekdayName: DAY_NAMES[today.getUTCDay()],
      isWirdDay: rules.wirdDays.includes(today.getUTCDay()),
      next: next
        ? {
            label: unitLabel(next, rules.dailyUnit),
            surah: next.surah,
            surahName: findSurah(next.surah)?.name ?? null,
            fromAyah: next.fromAyah,
            toAyah: next.toAyah,
            page: next.page,
            ayahCount: findSurah(next.surah)?.ayahCount ?? null,
            // The plan's next surah, which a juz' range may end before.
            nextSurahName: findSurah(units.slice(next.index).find((unit) => unit.surah !== next.surah)?.surah ?? 0)?.name ?? null,
          }
        : null,
      /** What the student memorized last, which the review step opens straight onto. */
      previous: previous
        ? {
            label: previous.count > 1 ? `${findSurah(previous.surah)?.name ?? ''} · ${previous.fromAyah}-${previous.toAyah}` : unitLabel(previous, rules.dailyUnit),
            surah: previous.surah,
            fromAyah: previous.fromAyah,
            toAyah: previous.toAyah,
            page: previous.page,
            /** How many portions the review covers. */
            portions: previous.count,
          }
        : null,
      steps: config.steps.map((step) => {
        const options = stepOptions(step);
        return {
          index: step.id,
          kind: step.kind,
          title: step.title,
          subtitle: stepSubtitle(step),
          // A unit she finished is finished, whatever its counters say.
          done: doneToday !== null || isStepDone(step, counts, config, Boolean(previous)),
          /** The step's own settings, for the buttons it shows. */
          options: {
            optional: step.kind !== 'TASK' && options.optional,
            showMushaf: options.showMushaf,
            allowPeek: options.allowPeek,
            selfConfirm: step.kind === 'SESSION' && options.selfConfirm,
            completion: step.kind === 'SESSION' ? options.completion : null,
          },
        };
      }),
      /**
       * How the track's students recite to the teacher: LIVE in a voice session, RECORDING by a recording sent
       * from the app, NONE not at all (the wird then has no session step).
       */
      recitationMode: config.recitationMode,
      /** The voice session for the session step, when the teacher has set one up. Only on a LIVE track. */
      liveSession,
      /**
       * The day's portion split into the track's sessions, such as morning and evening, each marked done on its own.
       * Empty when the track keeps the day whole. The wird completes once every session is done.
       */
      sessions: next
        ? sessionsOf(next, plan.template.dailySessions).map((session) => ({
            ...session,
            title: sessionName(session.number),
            label: session.fromAyah === session.toAyah ? `الآية ${session.fromAyah}` : `الآيات ${session.fromAyah}-${session.toAyah}`,
            done: doneToday !== null || (progressRow?.doneSessions ?? []).includes(session.number),
          }))
        : [],
      /** Today's wird is done, so `next` is the unit she finished and nothing more opens until tomorrow. */
      wirdDoneToday: doneToday !== null,
      /**
       * Today's wird in portions: what carried over from missed wird days plus today's own. `done` of `total`;
       * `carried` is how many of them are left over from earlier days.
       */
      todayPortions: { total: todayWird.total, done: todayWird.done, carried: summary.behindUnits },
      repeat: { count: counts.repeatCount, target: config.repeatTarget },
      review: { count: counts.reviewCount, target: config.reviewTarget },
      listen: { count: counts.listenCount, target: config.listenTarget },
      encouragements: plan.template.encouragements,
      gate: gate ?? null,
      week,
      weekSummary: {
        done: wirdThisWeek.filter((day) => day.state === 'done').length + (doneDates.has(todayKey) ? 1 : 0),
        total: wirdThisWeek.length,
        missed: wirdThisWeek.filter((day) => day.state === 'missed').map((day) => DAY_NAMES[day.weekday]),
        memorized: [...new Set(logsThisWeek.map(({ unitIndex }) => units[unitIndex]?.surah))].flatMap((surah) => {
          const name = findSurah(surah ?? 0)?.name;
          return name ? [name] : [];
        }),
      },
      todayDone: { wird: doneDates.has(todayKey), kinds: dayKinds.map(({ kind }) => kind) },
      /** The surah a wrap or consolidation day works on: the last one finished. */
      lastFinishedSurah: findLastFinished(units, plan.completedUnits),
      /** Every surah the student has memorized some of, in the order memorized: all there is to review. */
      reviewSurahs: [...new Set(units.slice(0, plan.completedUnits).map(({ surah }) => surah))].flatMap((surah) => {
        const name = findSurah(surah)?.name;
        return name ? [name] : [];
      }),
    };
  }

  async setStep(studentId: string, id: number, done: boolean): Promise<void> {
    const { planId, unitIndex, config } = await this.currentWird(studentId);
    const position = config.steps.findIndex((step) => step.id === id);
    if (position === -1) throw new ApiError(400, 'unknown_step');
    const step = config.steps[position];
    // A counted step finishes through its counter, and a session through the teacher, unless the track lets her mark it.
    if (!canSelfMark(step)) throw new ApiError(400, step.kind === 'SESSION' ? 'step_needs_teacher' : 'step_is_counted');

    const row = await this.prisma.wirdProgress.findUnique({ where: { planId_unitIndex: { planId, unitIndex } } });
    const counts = wirdCountsOf(row);
    // Steps go in order: nothing is memorized before the reading is mastered, and undoing a step reopens what followed it.
    if (done && !counts.doneSteps.includes(id) && firstOpenStep(counts, config, unitIndex > 0)?.id !== id) {
      throw new ApiError(409, 'wird_step_locked');
    }
    // What the teacher confirmed stays confirmed when an earlier step of hers is undone.
    const keep = new Set(config.steps.filter((other, index) => index < position || (other.kind === 'SESSION' && other.id !== id)).map((other) => other.id));
    const doneSteps = done ? [...new Set([...counts.doneSteps, id])] : counts.doneSteps.filter((other) => keep.has(other));
    await this.prisma.wirdProgress.upsert({
      where: { planId_unitIndex: { planId, unitIndex } },
      create: { planId, unitIndex, doneSteps },
      update: { doneSteps },
    });
  }

  /** One more repetition, one more review of the previous portion, or one more listen to the sheikh. */
  async addCount(studentId: string, kind: 'REPEAT' | 'REVIEW' | 'LISTEN'): Promise<{ count: number; target: number }> {
    const { planId, unitIndex, config } = await this.currentWird(studentId);
    const position = config.steps.findIndex((step) => step.kind === kind);
    if (position === -1) throw new ApiError(400, 'unknown_step');
    if (kind === 'REVIEW' && unitIndex === 0) throw new ApiError(409, 'nothing_to_review');

    const where = { planId, unitIndex };
    const before = await this.prisma.wirdProgress.findUnique({ where: { planId_unitIndex: where } });
    const counts = wirdCountsOf(before);
    const open = firstOpenStep(counts, config, unitIndex > 0);
    if (open && config.steps.indexOf(open) < position) throw new ApiError(409, 'wird_step_locked');

    await this.prisma.wirdProgress.createMany({ data: [{ planId, unitIndex, doneSteps: [] }], skipDuplicates: true });
    // The condition stops it at the target, however many taps arrive together.
    if (kind === 'REPEAT') {
      await this.prisma.wirdProgress.updateMany({ where: { ...where, repeatCount: { lt: config.repeatTarget } }, data: { repeatCount: { increment: 1 } } });
    } else if (kind === 'REVIEW') {
      await this.prisma.wirdProgress.updateMany({ where: { ...where, reviewCount: { lt: config.reviewTarget } }, data: { reviewCount: { increment: 1 } } });
    } else {
      await this.prisma.wirdProgress.updateMany({ where: { ...where, listenCount: { lt: config.listenTarget } }, data: { listenCount: { increment: 1 } } });
    }
    const row = await this.prisma.wirdProgress.findUniqueOrThrow({ where: { planId_unitIndex: where } });
    if (kind === 'REPEAT') return { count: row.repeatCount, target: config.repeatTarget };
    return kind === 'REVIEW' ? { count: row.reviewCount, target: config.reviewTarget } : { count: row.listenCount, target: config.listenTarget };
  }

  async completeDay(studentId: string, kind: 'REVIEW' | 'WRAP' | 'CONSOLIDATION', detail?: string): Promise<void> {
    if (kind === 'REVIEW' && !detail) throw new ApiError(400, 'review_detail_required');
    await this.prisma.dayCompletion.createMany({
      data: [{ studentId, doneOn: riyadhDate(), kind, detail }],
      skipDuplicates: true,
    });
  }

  async saveReflection(studentId: string, surah: number, body: string): Promise<void> {
    await this.prisma.tadabburReflection.upsert({
      where: { studentId_surah: { studentId, surah } },
      create: { studentId, surah, body },
      update: { body },
    });
  }

  async reflection(studentId: string, surah: number) {
    const row = await this.prisma.tadabburReflection.findUnique({ where: { studentId_surah: { studentId, surah } }, select: { body: true } });
    return { body: row?.body ?? '' };
  }

  async achievements(studentId: string, period: 'week' | 'month') {
    const today = riyadhDate();
    const days = period === 'week' ? 7 : 28;
    const since = plusDays(today, -(days - 1));
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      include: {
        template: { select: { dailyUnit: true, dailyAyahs: true, wirdDays: true, consolidationDays: true } },
        logs: { where: { doneOn: { gte: since } }, select: { doneOn: true, unitIndex: true } },
      },
    });
    const [scores, attendance, exam, summaries, reviews] = await Promise.all([
      this.prisma.evaluation.findMany({
        where: { studentId, score: { not: null }, createdAt: { gte: since } },
        select: { score: true, maxScore: true, createdAt: true },
      }),
      this.prisma.evaluation.findMany({
        where: { studentId, ...ATTENDANCE_DAY, createdAt: { gte: plusDays(today, -30) } },
        orderBy: { attendanceOn: 'desc' },
        select: { attendance: true },
      }),
      this.prisma.stageExam.findFirst({ where: { studentId, finalKind: null }, orderBy: { createdAt: 'desc' }, select: { stage: true, score: true, passed: true } }),
      this.plans.summaries([studentId]),
      this.prisma.dayCompletion.findMany({ where: { studentId, kind: 'REVIEW', doneOn: { gte: since } }, select: { detail: true } }),
    ]);
    const percent = (row: { score: unknown; maxScore: unknown }) => (Number(row.score) / Number(row.maxScore)) * 100;
    const average = (rows: { score: unknown; maxScore: unknown }[]) =>
      rows.length === 0 ? null : Math.round(rows.reduce((sum, row) => sum + percent(row), 0) / rows.length);

    const bars =
      period === 'week'
        ? Array.from({ length: 7 }, (_, offset) => {
            const date = plusDays(today, offset - 6);
            const key = iso(date);
            return {
              label: DAY_NAMES[date.getUTCDay()].replace('ال', '').charAt(0),
              value: average(scores.filter(({ createdAt }) => iso(riyadhDate(createdAt)) === key)) ?? 0,
            };
          })
        : Array.from({ length: 4 }, (_, offset) => {
            const start = plusDays(since, offset * 7);
            const end = plusDays(start, 7);
            return {
              label: ['الأول', 'الثاني', 'الثالث', 'الرابع'][offset],
              value: average(scores.filter(({ createdAt }) => createdAt >= start && createdAt < end)) ?? 0,
            };
          });

    const logs = plan?.logs ?? [];
    const units = plan?.template.dailyUnit ? buildUnits(plan.template.dailyUnit, plan.surahOrder, plan.pageRange, plan.template.dailyAyahs) : [];
    const summary = summaries.get(studentId);

    return {
      mastery: average(scores),
      bars,
      commitmentDays: new Set(logs.map(({ doneOn }) => iso(doneOn))).size,
      pages: logs.reduce((sum, { unitIndex }) => sum + (units[unitIndex]?.pages ?? 0), 0),
      reviewsDone: reviews.length,
      absenceLevel: absenceLevel(attendance.flatMap(({ attendance: status }) => (status ? [status] : []))),
      progress: summary?.status === 'no_plan' ? null : (summary?.progress ?? null),
      finish:
        plan?.template.dailyUnit && units.length > 0
          ? projectFinish(
              units,
              { dailyUnit: plan.template.dailyUnit, dailyAyahs: plan.template.dailyAyahs, wirdDays: plan.template.wirdDays, consolidationDays: plan.template.consolidationDays },
              plan.completedUnits,
              today,
            )
          : null,
      stageExam: exam && { stage: exam.stage, score: Number(exam.score), passed: exam.passed },
    };
  }

  async badgeBoard(studentId: string) {
    const today = riyadhDate();
    const weekStart = plusDays(today, -today.getUTCDay());
    const [badges, plan, gates, messages] = await Promise.all([
      this.badgeService.forStudent(studentId),
      this.prisma.studentPlan.findUnique({
        where: { studentId },
        select: {
          status: true,
          surahOrder: true,
          pageRange: true,
          completedAt: true,
          updatedAt: true,
          student: { select: { fullName: true, section: true } },
          template: { select: { name: true, dailyUnit: true, dailyAyahs: true } },
          logs: { where: { doneOn: { gte: weekStart } }, select: { doneOn: true, unitIndex: true } },
        },
      }),
      this.prisma.surahGate.count({ where: { studentId, status: 'PASSED', decidedAt: { gte: weekStart } } }),
      this.prisma.notification.findMany({
        where: { userId: studentId, type: 'ENCOURAGEMENT' },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, body: true },
      }),
    ]);
    const summary = (await this.plans.summaries([studentId])).get(studentId);
    const units = plan?.template.dailyUnit ? buildUnits(plan.template.dailyUnit, plan.surahOrder, plan.pageRange, plan.template.dailyAyahs) : [];

    return {
      badges,
      trackProgress: summary?.progress ?? 0,
      certificate:
        plan?.status === 'COMPLETED'
          ? {
              trackName: plan.template.name,
              studentName: plan.student.fullName,
              section: plan.student.section,
              completedAt: plan.completedAt ?? plan.updatedAt,
            }
          : null,
      week: {
        from: weekStart,
        to: plusDays(weekStart, 6),
        pages: (plan?.logs ?? []).reduce((sum, { unitIndex }) => sum + (units[unitIndex]?.pages ?? 0), 0),
        surahsPassed: gates,
        committedDays: new Set((plan?.logs ?? []).map(({ doneOn }) => iso(doneOn))).size,
      },
      encouragements: messages.map(({ id, body }) => ({ id, text: body })),
    };
  }

  /** The student's history: units done, recitations, gates and review days, newest first. */
  async log(studentId: string, period: 'week' | 'month' | 'all') {
    const today = riyadhDate();
    const since = period === 'all' ? undefined : plusDays(today, period === 'week' ? -6 : -29);
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      select: {
        surahOrder: true,
        pageRange: true,
        template: { select: { dailyUnit: true, dailyAyahs: true } },
        logs: { where: since ? { doneOn: { gte: since } } : {}, orderBy: { doneOn: 'desc' }, take: 200 },
      },
    });
    const [evaluations, gates, days] = await Promise.all([
      this.prisma.evaluation.findMany({
        where: { studentId, ...(since ? { createdAt: { gte: since } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, title: true, surah: true, score: true, maxScore: true, attendance: true, segmentStatus: true, createdAt: true },
      }),
      this.prisma.surahGate.findMany({
        where: { studentId, status: { in: ['PASSED', 'SKIPPED'] }, ...(since ? { decidedAt: { gte: since } } : {}) },
        select: { id: true, surah: true, status: true, decidedAt: true },
      }),
      this.prisma.dayCompletion.findMany({
        where: { studentId, ...(since ? { doneOn: { gte: since } } : {}) },
        orderBy: { doneOn: 'desc' },
        take: 100,
      }),
    ]);

    const dailyUnit = plan?.template.dailyUnit;
    const units = dailyUnit ? buildUnits(dailyUnit, plan.surahOrder, plan.pageRange, plan.template.dailyAyahs) : [];
    const entries = [
      ...(plan?.logs ?? []).flatMap((row) => {
        const unit = units[row.unitIndex];
        return unit && dailyUnit
          ? [{ id: `w${row.unitIndex}`, at: row.doneOn, kind: 'wird', title: `حفظ: ${unitLabel(unit, dailyUnit)}`, status: row.source === 'SKIP' ? 'skipped' : 'done', score: null as number | null }]
          : [];
      }),
      ...evaluations.map((row) => ({
        id: row.id,
        at: row.createdAt,
        kind: 'evaluation',
        title: row.surah === null ? 'تسجيل الحضور' : `تسميع: ${row.title}`,
        status: row.attendance === 'ABSENT' ? 'absent' : row.surah === null ? 'done' : row.segmentStatus === 'NEEDS_REVIEW' ? 'needs_review' : 'mastered',
        score: row.score === null ? null : Number(row.score),
      })),
      ...gates.map((row) => ({
        id: row.id,
        at: row.decidedAt ?? today,
        kind: 'gate',
        title: `اجتياز سورة ${findSurah(row.surah)?.name ?? ''}`,
        status: row.status === 'SKIPPED' ? 'skipped' : 'passed',
        score: null as number | null,
      })),
      ...days.map((row) => ({
        id: `${row.kind}${iso(row.doneOn)}`,
        at: row.doneOn,
        kind: 'day',
        title: `${row.kind === 'REVIEW' ? 'مراجعة' : row.kind === 'WRAP' ? 'تغليف' : 'تثبيت وتفسير'}${row.detail ? `: ${row.detail}` : ''}`,
        status: 'done',
        score: null as number | null,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    const memorizedSurahs = new Set(units.filter((unit) => unit.lastOfSurah && (plan?.logs ?? []).some((row) => row.unitIndex === unit.index)).map((unit) => unit.surah));
    return {
      stats: { memorizedSurahs: memorizedSurahs.size, passedSurahs: gates.length, recitations: evaluations.filter((row) => row.score !== null).length },
      entries,
    };
  }

  async publicTracks() {
    const tracks = await this.prisma.trackTemplate.findMany({
      // A review track is given after the admission test, so students don't see it among the tracks to choose.
      where: { active: true, kind: { not: 'REVIEW' } },
      orderBy: { createdAt: 'asc' },
      select: {
        code: true,
        kind: true,
        name: true,
        audience: true,
        duration: true,
        dailyUnit: true, dailyAyahs: true,
        wirdDays: true,
        consolidationDays: true,
        memorizationOrder: true,
        juzFrom: true,
        juzTo: true,
        selectedSurahs: true,
        startSurah: true,
        recitationMode: true,
      },
    });
    return tracks.map(({ memorizationOrder, juzFrom, juzTo, selectedSurahs, startSurah, recitationMode, ...track }) => ({
      ...track,
      /** Online recitation with a teacher, which only the women's section has. */
      liveRecitation: recitationMode === 'LIVE',
      scopeLabel: track.kind !== 'CORRECTION' ? scopeLabel(memorizationOrder, juzFrom, juzTo, selectedSurahs, startSurah) : null,
      dailyLabel: track.dailyUnit ? dailyUnitLabel(track.dailyUnit, track.dailyAyahs) : null,
      daysLabel: track.wirdDays.length > 0 ? formatDays(track.wirdDays) : null,
      reviewLabel: track.wirdDays.length > 0 ? formatDays([0, 1, 2, 3, 4, 5, 6].filter((day) => !track.wirdDays.includes(day))) : null,
    }));
  }

  private async circleSummary(studentId: string) {
    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null },
      select: {
        circleId: true,
        circle: { select: { name: true, teacher: { select: { fullName: true } } } },
      },
    });
    if (!membership) return null;
    const [task, evaluation] = await Promise.all([
      this.prisma.task.findFirst({
        where: { circleId: membership.circleId, archivedAt: null, OR: [{ studentId: null }, { studentId }] },
        orderBy: { createdAt: 'desc' },
        select: { id: true, title: true, recurrence: true, dueAt: true },
      }),
      this.prisma.evaluation.findFirst({
        where: { studentId, score: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { title: true, score: true, maxScore: true, comment: true },
      }),
    ]);
    return {
      name: membership.circle.name,
      teacherName: membership.circle.teacher?.fullName ?? null,
      latestTask: task,
      latestEvaluation: evaluation && { ...evaluation, score: Number(evaluation.score), maxScore: Number(evaluation.maxScore) },
    };
  }

  private async latestAnnouncement(studentId: string) {
    const student = await this.prisma.user.findUniqueOrThrow({
      where: { id: studentId },
      select: {
        trackTemplateId: true,
        memberships: { where: { leftAt: null }, select: { circleId: true, circle: { select: { scopeId: true } } } },
      },
    });
    const membership = student.memberships.at(0);
    const now = new Date();
    return this.prisma.announcement.findFirst({
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
      select: { id: true, title: true, body: true, createdAt: true },
    });
  }

  /** The teacher's latest verdict on each segment: what was marked for review, and hasn't been marked mastered since. */
  private async reviewSegments(studentId: string) {
    const rows = await this.prisma.evaluation.findMany({
      where: { studentId, segmentStatus: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { title: true, segmentStatus: true },
    });
    const seen = new Set<string>();
    const due: string[] = [];
    for (const { title, segmentStatus } of rows) {
      if (seen.has(title)) continue;
      seen.add(title);
      if (segmentStatus === 'NEEDS_REVIEW') due.push(title);
    }
    return due.slice(0, 10);
  }

  /** Each recited segment's next date, from the teacher's latest verdict and the student's reviews since. */
  async reviewSchedule(studentId: string) {
    const today = riyadhDate();
    const rows = await this.prisma.evaluation.findMany({
      where: { studentId, segmentStatus: { not: null }, surah: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        id: true,
        title: true,
        surah: true,
        score: true,
        maxScore: true,
        segmentStatus: true,
        createdAt: true,
        reviews: { orderBy: { doneOn: 'desc' }, select: { doneOn: true } },
      },
    });
    const seen = new Set<string>();
    const segments = rows.flatMap((row) => {
      if (seen.has(row.title)) return [];
      seen.add(row.title);
      const mastered = row.segmentStatus === 'MASTERED';
      const dueOn = nextSegmentReview({
        mastered,
        reviews: row.reviews.length,
        since: row.reviews[0]?.doneOn ?? riyadhDate(row.createdAt),
      });
      return [
        {
          id: row.id,
          title: row.title,
          surah: row.surah,
          level: mastered ? ('mastered' as const) : ('needs_review' as const),
          score: row.score === null ? null : Number(row.score),
          maxScore: Number(row.maxScore),
          dueOn,
          reviews: row.reviews.length,
          reviewedToday: row.reviews[0]?.doneOn.getTime() === today.getTime(),
          daysLeft: Math.round((dueOn.getTime() - today.getTime()) / DAY_MS),
        },
      ];
    });
    segments.sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime());
    const plan = await this.planView(studentId);
    return {
      remainingDays: plan?.remainingDays ?? null,
      today: segments.filter(({ daysLeft }) => daysLeft <= 0),
      upcoming: segments.filter(({ daysLeft }) => daysLeft > 0),
    };
  }

  /** Limited to the student's own segments. The key makes a second tap in a day do nothing. */
  async markSegmentReviewed(studentId: string, evaluationId: string): Promise<void> {
    const row = await this.prisma.evaluation.findFirst({ where: { id: evaluationId, studentId, segmentStatus: { not: null } }, select: { id: true } });
    if (!row) throw new ApiError(404, 'not_found');
    await this.prisma.segmentReview.createMany({ data: [{ evaluationId, doneOn: riyadhDate() }], skipDuplicates: true });
  }

  private async currentWird(studentId: string) {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      select: { id: true, completedUnits: true, status: true, template: { select: { wirdSteps: true, recitationMode: true, repeatTarget: true, reviewTarget: true, listenTarget: true } } },
    });
    if (!plan) throw new ApiError(404, 'no_plan');
    if (plan.status === 'COMPLETED') throw new ApiError(409, 'plan_completed');
    if ((await this.plans.ownWirdToday(plan.id)) !== null) throw new ApiError(409, 'wird_done_today');
    return { planId: plan.id, unitIndex: plan.completedUnits, config: wirdConfigOf(plan.template) };
  }

  /** Marks one of today's sessions done or not. Sessions go in any order, as the student's day allows. */
  async setSession(studentId: string, number: number, done: boolean): Promise<void> {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      select: {
        id: true,
        completedUnits: true,
        status: true,
        surahOrder: true,
        pageRange: true,
        template: { select: { dailyUnit: true, dailyAyahs: true, dailySessions: true } },
      },
    });
    if (!plan?.template.dailyUnit) throw new ApiError(404, 'no_plan');
    if (plan.status === 'COMPLETED') throw new ApiError(409, 'plan_completed');
    if ((await this.plans.ownWirdToday(plan.id)) !== null) throw new ApiError(409, 'wird_done_today');

    const unit = buildUnits(plan.template.dailyUnit, plan.surahOrder, plan.pageRange, plan.template.dailyAyahs)[plan.completedUnits];
    const sessions = unit ? sessionsOf(unit, plan.template.dailySessions) : [];
    if (!sessions.some((session) => session.number === number)) throw new ApiError(400, 'unknown_session');

    const key = { planId_unitIndex: { planId: plan.id, unitIndex: plan.completedUnits } };
    const row = await this.prisma.wirdProgress.findUnique({ where: key, select: { doneSessions: true } });
    const current = row?.doneSessions ?? [];
    const doneSessions = done ? [...new Set([...current, number])].sort((a, b) => a - b) : current.filter((other) => other !== number);
    await this.prisma.wirdProgress.upsert({
      where: key,
      create: { planId: plan.id, unitIndex: plan.completedUnits, doneSteps: [], doneSessions },
      update: { doneSessions },
    });
  }

  private async currentUnit(studentId: string) {
    const plan = await this.prisma.studentPlan.findUnique({ where: { studentId }, select: { id: true, completedUnits: true, status: true } });
    if (!plan) throw new ApiError(404, 'no_plan');
    if (plan.status === 'COMPLETED') throw new ApiError(409, 'plan_completed');
    return { planId: plan.id, unitIndex: plan.completedUnits };
  }
}

function findLastFinished(units: ReturnType<typeof buildUnits>, completed: number): { surah: number; name: string | null; ayahCount: number | null } | null {
  for (let index = Math.min(completed, units.length) - 1; index >= 0; index--) {
    if (units[index].lastOfSurah) {
      const surah = findSurah(units[index].surah);
      return { surah: units[index].surah, name: surah?.name ?? null, ayahCount: surah?.ayahCount ?? null };
    }
  }
  return null;
}

function formatDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 0) return 'لا يوجد';
  if (sorted.length === 7) return 'طوال الأسبوع';
  if (sorted.length === 2) return `${DAY_NAMES[sorted[0]]} و${DAY_NAMES[sorted[1]]}`;
  const consecutive = sorted.every((day, index) => index === 0 || day === sorted[index - 1] + 1);
  return consecutive && sorted.length > 2
    ? `${DAY_NAMES[sorted[0]]}–${DAY_NAMES[sorted.at(-1)!]}`
    : sorted.map((day) => DAY_NAMES[day]).join('، ');
}

