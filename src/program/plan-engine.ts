import { SURAH_PAGES } from '../common/mushaf.js';
import { SURAHS } from '../common/surahs.js';
import type { DailyUnit } from '../generated/prisma/enums.js';

// Turns a track's rules into a student's schedule. Pure functions over dates and numbers, with no
// database, so every rule can be tested directly. All dates are date-only values at UTC midnight.

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlanUnit {
  index: number;
  surah: number;
  /** The mushaf page it starts on. */
  page: number;
  fromAyah: number;
  toAyah: number;
  /** How much of the mushaf this unit covers, in pages. */
  pages: number;
  lastOfSurah: boolean;
}

export interface PlanRules {
  dailyUnit: DailyUnit;
  wirdDays: number[];
  consolidationDays: number;
}

export type PlanStep = { type: 'unit'; unitIndex: number } | { type: 'consolidation'; surah: number };

const surahName = (surah: number) => SURAHS[surah - 1].name;

export const unitLabel = (unit: PlanUnit, dailyUnit: DailyUnit): string =>
  dailyUnit === 'SURAH' ? surahName(unit.surah) : `${surahName(unit.surah)} · ${unit.fromAyah}-${unit.toAyah}`;

export function buildUnits(dailyUnit: DailyUnit, surahOrder: number[]): PlanUnit[] {
  const units: PlanUnit[] = [];
  const add = (surah: number, page: number, fromAyah: number, toAyah: number, pages: number) =>
    units.push({ index: units.length, surah, page, fromAyah, toAyah, pages, lastOfSurah: false });

  for (const surah of surahOrder) {
    const chunks = SURAH_PAGES[surah];
    if (dailyUnit === 'SURAH') {
      add(surah, chunks[0][0], chunks[0][1], chunks.at(-1)![3], chunks.length);
    } else {
      for (const [page, from, mid, to] of chunks) {
        if (dailyUnit === 'PAGE' || mid >= to) {
          // A half-page day can't split a single ayah, so a one-ayah page stays whole.
          add(surah, page, from, to, dailyUnit === 'PAGE' ? 1 : 0.5);
        } else {
          add(surah, page, from, mid, 0.5);
          add(surah, page, mid + 1, to, 0.5);
        }
      }
    }
    units[units.length - 1].lastOfSurah = true;
  }
  return units;
}

/** The order of wird days: each unit, with consolidation days after each surah's last unit. */
export function buildSteps(units: PlanUnit[], consolidationDays: number): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const unit of units) {
    steps.push({ type: 'unit', unitIndex: unit.index });
    if (unit.lastOfSurah) {
      for (let day = 0; day < consolidationDays; day++) steps.push({ type: 'consolidation', surah: unit.surah });
    }
  }
  return steps;
}

/** How many wird days fall from `from` to `to`, both included. */
export function countWirdDays(from: Date, to: Date, wirdDays: number[]): number {
  const days = Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days <= 0) return 0;
  const startDay = from.getUTCDay();
  let count = Math.floor(days / 7) * wirdDays.length;
  for (let offset = 0; offset < days % 7; offset++) {
    if (wirdDays.includes((startDay + offset) % 7)) count++;
  }
  return count;
}

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

export interface PlanPosition {
  startOn: Date;
  completedUnits: number;
  creditedDays: number;
  /** The day a gate opened and is still waiting, which stops the clock. */
  gateOpenedOn: Date | null;
}

export interface PlanProgress {
  totalUnits: number;
  completedUnits: number;
  expectedUnits: number;
  behindUnits: number;
  behindPages: number;
  behindDays: number;
  /** Share of the expected units done, capped at 100. Null before anything is due. */
  commitment: number | null;
  /** Share of the whole track done. */
  progress: number;
}

export function computeProgress(units: PlanUnit[], rules: PlanRules, position: PlanPosition, today: Date): PlanProgress {
  const steps = buildSteps(units, rules.consolidationDays);
  // Time spent waiting on a gate isn't the student's delay, so it doesn't count.
  const clock = position.gateOpenedOn && position.gateOpenedOn < today ? position.gateOpenedOn : today;
  // Today's work isn't late until today is over, so only days already finished are counted.
  const effective = addDays(clock, -position.creditedDays - 1);
  const dueSteps = Math.min(countWirdDays(position.startOn, effective, rules.wirdDays), steps.length);

  let expectedUnits = 0;
  let stepsForCompleted = 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step.type !== 'unit') continue;
    if (index < dueSteps) expectedUnits++;
    if (step.unitIndex < position.completedUnits) stepsForCompleted = index + 1;
  }

  const behindUnits = Math.max(0, expectedUnits - position.completedUnits);
  const behindPages = units
    .slice(position.completedUnits, position.completedUnits + behindUnits)
    .reduce((sum, unit) => sum + unit.pages, 0);

  return {
    totalUnits: units.length,
    completedUnits: position.completedUnits,
    expectedUnits,
    behindUnits,
    behindPages,
    behindDays: behindUnits > 0 ? dueSteps - stepsForCompleted : 0,
    commitment: expectedUnits === 0 ? null : Math.min(100, Math.round((position.completedUnits / expectedUnits) * 100)),
    progress: units.length === 0 ? 0 : Math.round((position.completedUnits / units.length) * 100),
  };
}

export type DayKind = 'memorize' | 'consolidation' | 'review' | 'gate' | 'finished' | 'before_start';
export type DayState = 'done' | 'missed' | 'today' | 'upcoming';

export interface PlanDay {
  date: string;
  /** Sunday = 0. */
  weekday: number;
  kind: DayKind;
  label: string | null;
  state: DayState;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The week around today. Past wird days show what actually happened. Today and later days lay out
 * what comes next from where the student really is, so catching up doesn't scramble the week.
 */
export function buildWeek(
  units: PlanUnit[],
  rules: PlanRules,
  position: PlanPosition,
  today: Date,
  doneDates: Set<string>,
): PlanDay[] {
  const steps = buildSteps(units, rules.consolidationDays);
  const firstNext = steps.findIndex((step) => step.type === 'unit' && step.unitIndex === position.completedUnits);
  let nextStep = firstNext;
  const sunday = addDays(today, -today.getUTCDay());

  return Array.from({ length: 7 }, (_, offset) => {
    const date = addDays(sunday, offset);
    const weekday = date.getUTCDay();
    const base = { date: isoDate(date), weekday };
    const isPast = date < today;
    const state: DayState = date.getTime() === today.getTime() ? 'today' : isPast ? 'missed' : 'upcoming';

    if (date < position.startOn) return { ...base, kind: 'before_start', label: null, state: isPast ? 'missed' : 'upcoming' };
    if (!rules.wirdDays.includes(weekday)) {
      return { ...base, kind: 'review', label: null, state: isPast ? 'done' : state };
    }
    if (isPast) {
      return { ...base, kind: 'memorize', label: null, state: doneDates.has(base.date) ? 'done' : 'missed' };
    }
    if (position.gateOpenedOn) return { ...base, kind: 'gate', label: null, state };
    if (nextStep < 0 || nextStep >= steps.length) return { ...base, kind: 'finished', label: null, state };

    const step = steps[nextStep++];
    if (step.type === 'consolidation') return { ...base, kind: 'consolidation', label: surahName(step.surah), state };
    return { ...base, kind: 'memorize', label: unitLabel(units[step.unitIndex], rules.dailyUnit), state };
  });
}

/** Describes how far behind a student is, such as «3 أيام · وجهان». */
export function delayLabel({ behindDays, behindPages }: Pick<PlanProgress, 'behindDays' | 'behindPages'>): string | null {
  if (behindDays === 0) return null;
  const days = behindDays === 1 ? 'يوم' : behindDays === 2 ? 'يومان' : behindDays <= 10 ? `${behindDays} أيام` : `${behindDays} يومًا`;
  const pages =
    behindPages === 0.5 ? 'نصف وجه'
    : behindPages === 1 ? 'وجه'
    : behindPages === 2 ? 'وجهان'
    : behindPages <= 10 && Number.isInteger(behindPages) ? `${behindPages} أوجه`
    : `${behindPages} وجهًا`;
  return `${days} · ${pages}`;
}

/** The day a student would finish if every remaining step falls on the next wird days. */
export function projectFinish(
  units: PlanUnit[],
  rules: PlanRules,
  completedUnits: number,
  today: Date,
): { remainingDays: number; finishOn: Date } | null {
  if (rules.wirdDays.length === 0) return null;
  const steps = buildSteps(units, rules.consolidationDays);
  const next = steps.findIndex((step) => step.type === 'unit' && step.unitIndex === completedUnits);
  if (next < 0) return { remainingDays: 0, finishOn: today };

  let remaining = steps.length - next;
  let date = today;
  for (;;) {
    if (rules.wirdDays.includes(date.getUTCDay())) remaining--;
    if (remaining <= 0) break;
    date = addDays(date, 1);
  }
  return { remainingDays: Math.round((date.getTime() - today.getTime()) / DAY_MS), finishOn: date };
}

/** How many wird days in a row were done, walking back from the last wird day before today. */
export function computeStreak(doneDates: Set<string>, wirdDays: number[], today: Date): number {
  if (wirdDays.length === 0) return 0;
  let streak = doneDates.has(isoDate(today)) ? 1 : 0;
  let date = addDays(today, -1);
  for (let day = 0; day < 800; day++, date = addDays(date, -1)) {
    if (!wirdDays.includes(date.getUTCDay())) continue;
    if (!doneDates.has(isoDate(date))) break;
    streak++;
  }
  return streak;
}

/** The absence warning due, from attendance records newest first: 3 after 5 absences, 2 after 3 in a row, 1 after 2. */
export function absenceLevel(recentNewestFirst: string[]): 1 | 2 | 3 | null {
  const absences = recentNewestFirst.filter((status) => status === 'ABSENT').length;
  if (absences >= 5) return 3;
  const inARow = recentNewestFirst.findIndex((status) => status !== 'ABSENT');
  if ((inARow === -1 ? recentNewestFirst.length : inARow) >= 3) return 2;
  return absences >= 2 ? 1 : null;
}

/** Days until the next review of a segment. Each review done moves it one step further out. */
export const REVIEW_INTERVALS = [1, 3, 7, 14, 30, 60];
const MASTERED_START = 2;

/** A segment marked for review comes back the next day. A mastered one starts a week out. */
export function nextSegmentReview({ mastered, reviews, since }: { mastered: boolean; reviews: number; since: Date }): Date {
  const step = Math.min(reviews + (mastered ? MASTERED_START : 0), REVIEW_INTERVALS.length - 1);
  return new Date(since.getTime() + REVIEW_INTERVALS[step] * DAY_MS);
}

/**
 * The day's wird is a track's own list of steps, done in order. REVIEW and REPEAT finish through their
 * counters, LISTEN through its player, and TASK through its own button. An id stays with its step
 * when the list is reordered, so a student's finished steps stay finished.
 */
export type WirdStepKind = 'REVIEW' | 'LISTEN' | 'TASK' | 'REPEAT';
export interface WirdStepDef {
  id: number;
  kind: WirdStepKind;
  title: string;
  subtitle: string;
}
export interface WirdConfig {
  steps: WirdStepDef[];
  repeatTarget: number;
  reviewTarget: number;
}
export interface WirdCounts {
  doneSteps: number[];
  repeatCount: number;
  reviewCount: number;
}

export const DEFAULT_WIRD_STEPS: WirdStepDef[] = [
  { id: 0, kind: 'REVIEW', title: 'تسميع الوجه السابق غيبًا', subtitle: '' },
  { id: 1, kind: 'LISTEN', title: 'سماع الشيخ لنصاب اليوم', subtitle: 'مع فتح المصحف' },
  { id: 2, kind: 'TASK', title: 'قراءة النصاب نظرًا حتى إتقانه', subtitle: 'قبل البدء بالحفظ' },
  { id: 3, kind: 'TASK', title: 'البدء بحفظ النصاب حتى التمكّن', subtitle: 'بعد إتقان القراءة نظرًا وتسميعها لشخص آخر' },
  { id: 4, kind: 'REPEAT', title: 'تكرار النصاب غيبًا', subtitle: 'إجباري للحفظ الجديد' },
  { id: 5, kind: 'TASK', title: 'سرد وربط السورتين السابقتين', subtitle: 'مع النصاب الجديد' },
];

export function wirdConfigOf(template: { wirdSteps: unknown; repeatTarget: number; reviewTarget: number }): WirdConfig {
  return {
    steps: (template.wirdSteps as WirdStepDef[] | null) ?? DEFAULT_WIRD_STEPS,
    repeatTarget: template.repeatTarget,
    reviewTarget: template.reviewTarget,
  };
}

/** The first portion has nothing before it, so there is nothing to review yet. */
export function isStepDone(step: WirdStepDef, counts: WirdCounts, config: WirdConfig, hasPrevious: boolean): boolean {
  if (step.kind === 'REPEAT') return counts.repeatCount >= config.repeatTarget;
  if (step.kind === 'REVIEW') return !hasPrevious || counts.reviewCount >= config.reviewTarget;
  return counts.doneSteps.includes(step.id);
}

/** The step a student must do next, or null when all are done. */
export function firstOpenStep(counts: WirdCounts, config: WirdConfig, hasPrevious: boolean): WirdStepDef | null {
  return config.steps.find((step) => !isStepDone(step, counts, config, hasPrevious)) ?? null;
}

/**
 * How many units of a new size are fully covered by the work already done.
 * A partly covered unit stays open, so no memorization is ever counted that wasn't done.
 */
export function convertCompletedUnits(from: PlanUnit[], to: PlanUnit[], completed: number): number {
  const last = from[completed - 1] as PlanUnit | undefined;
  if (!last) return 0;
  const start = to.findIndex((unit) => unit.surah === last.surah);
  const covered = to.findIndex((unit, index) => index >= start && (unit.surah !== last.surah || unit.toAyah > last.toAyah));
  return covered === -1 ? to.length : covered;
}
