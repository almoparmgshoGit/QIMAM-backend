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
  /** The ayahs of each day when dailyUnit is AYAHS. */
  dailyAyahs?: number | null;
  wirdDays: number[];
  consolidationDays: number;
}

/** What a day's new memorization is: the unit, and its number of ayahs when it counts ayahs. */
export type DailyAmount = Pick<PlanRules, 'dailyUnit' | 'dailyAyahs'>;

export type PlanStep ={ type: 'unit'; unitIndex: number } | { type: 'consolidation'; surah: number };

const surahName = (surah: number) => SURAHS[surah - 1].name;

/** A whole surah goes by its name. A surah cut by a juz' range also shows its ayahs. */
export const unitLabel = (unit: PlanUnit, dailyUnit: DailyUnit): string =>
  dailyUnit === 'SURAH' && unit.fromAyah === 1 && unit.toAyah === SURAHS[unit.surah - 1].ayahCount
    ? surahName(unit.surah)
    : `${surahName(unit.surah)} · ${unit.fromAyah}-${unit.toAyah}`;

/** «آية واحدة يوميًا», «آيتان يوميًا», «5 آيات يوميًا», «12 آية يوميًا». */
export function ayahsLabel(count: number): string {
  if (count === 1) return 'آية واحدة يوميًا';
  if (count === 2) return 'آيتان يوميًا';
  return `${count} ${count <= 10 ? 'آيات' : 'آية'} يوميًا`;
}

const UNIT_LABELS: Record<Exclude<DailyUnit, 'AYAHS'>, string> = {
  HALF_PAGE: 'نصف وجه يوميًا',
  PAGE: 'وجه كامل يوميًا',
  SURAH: 'سورة بسورة',
};

/** The daily amount as students and staff read it. */
export const dailyUnitLabel = (dailyUnit: DailyUnit, dailyAyahs?: number | null): string =>
  dailyUnit === 'AYAHS' ? ayahsLabel(dailyAyahs ?? 1) : UNIT_LABELS[dailyUnit];

/**
 * The plan's units in order. A page range, [first, last], keeps only the pages inside it, as a juz' range does,
 * so a surah it cuts through is memorized only in part. An empty range is the whole Quran.
 * With AYAHS, each surah is cut every `dailyAyahs` ayahs, and its last day takes what remains.
 */
export function buildUnits(dailyUnit: DailyUnit, surahOrder: number[], pageRange: number[] = [], dailyAyahs?: number | null): PlanUnit[] {
  const units: PlanUnit[] = [];
  const add = (surah: number, page: number, fromAyah: number, toAyah: number, pages: number) =>
    units.push({ index: units.length, surah, page, fromAyah, toAyah, pages, lastOfSurah: false });
  const [firstPage = 1, lastPage = Infinity] = pageRange;

  for (const surah of surahOrder) {
    const chunks = SURAH_PAGES[surah].filter(([page]) => page >= firstPage && page <= lastPage);
    if (chunks.length === 0) continue;
    if (dailyUnit === 'SURAH') {
      add(surah, chunks[0][0], chunks[0][1], chunks.at(-1)![3], chunks.length);
    } else if (dailyUnit === 'AYAHS') {
      const size = Math.max(1, dailyAyahs ?? 1);
      const last = chunks.at(-1)![3];
      for (let from = chunks[0][1]; from <= last; from += size) {
        const to = Math.min(from + size - 1, last);
        // The page it starts on, and how much of each page it covers, by its share of that page's ayahs.
        const start = chunks.find(([, first, , end]) => from >= first && from <= end)!;
        const pages = chunks.reduce((sum, [, first, , end]) => {
          const overlap = Math.min(to, end) - Math.max(from, first) + 1;
          return overlap > 0 ? sum + overlap / (end - first + 1) : sum;
        }, 0);
        add(surah, start[0], from, to, Math.round(pages * 100) / 100);
      }
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

export interface WirdSession {
  /** From 1. */
  number: number;
  fromAyah: number;
  toAyah: number;
}

const SESSION_NAMES = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة'];
export const sessionName = (number: number) => `الفترة ${SESSION_NAMES[number - 1] ?? number}`;

/**
 * The day's portion split by ayahs into the track's sessions, as evenly as whole ayahs allow, earlier sessions
 * taking any extra. A portion with fewer ayahs than sessions has one session per ayah. Empty when the day isn't split.
 */
export function sessionsOf(unit: Pick<PlanUnit, 'fromAyah' | 'toAyah'>, dailySessions: number | null | undefined): WirdSession[] {
  if (!dailySessions || dailySessions < 2) return [];
  const ayahs = unit.toAyah - unit.fromAyah + 1;
  const count = Math.min(dailySessions, ayahs);
  if (count < 2) return [];
  const base = Math.floor(ayahs / count);
  const extra = ayahs % count;
  const sessions: WirdSession[] = [];
  let from = unit.fromAyah;
  for (let number = 1; number <= count; number++) {
    const size = base + (number <= extra ? 1 : 0);
    sessions.push({ number, fromAyah: from, toAyah: from + size - 1 });
    from += size;
  }
  return sessions;
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

/**
 * How many plan steps have fallen due, not counting days spent waiting on a gate or credited.
 * With `includeToday` today's step counts too; otherwise only days already over do.
 */
function dueStepsOf(steps: PlanStep[], rules: PlanRules, position: PlanPosition, today: Date, includeToday: boolean): number {
  // Time spent waiting on a gate isn't the student's delay, so it doesn't count.
  const clock = position.gateOpenedOn && position.gateOpenedOn < today ? position.gateOpenedOn : today;
  const effective = addDays(clock, -position.creditedDays - (includeToday ? 0 : 1));
  return Math.min(countWirdDays(position.startOn, effective, rules.wirdDays), steps.length);
}

/**
 * The units today's wird must reach: everything due up to and including today. A wird day missed carries over,
 * so today's wird is what was left undone plus today's own portion.
 */
export function dueUnitsToday(units: PlanUnit[], rules: PlanRules, position: PlanPosition, today: Date): number {
  const steps = buildSteps(units, rules.consolidationDays);
  const due = dueStepsOf(steps, rules, position, today, true);
  return steps.slice(0, due).filter((step) => step.type === 'unit').length;
}

export function computeProgress(units: PlanUnit[], rules: PlanRules, position: PlanPosition, today: Date): PlanProgress {
  const steps = buildSteps(units, rules.consolidationDays);
  // Today's work isn't late until today is over, so only days already finished are counted.
  const dueSteps = dueStepsOf(steps, rules, position, today, false);

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
 * The day's wird is a track's own list of steps, done in order. REVIEW, REPEAT and LISTEN finish through
 * their counters (LISTEN's is in the player), TASK through its own button, and SESSION when the teacher
 * hears the portion, in a voice session or a recording as the track's RecitationMode says, or the student
 * confirms it where the track allows. A track that recites by neither leaves SESSION out. An id stays with
 * its step when the list is reordered, so a student's finished steps stay finished.
 */
export type WirdStepKind = 'REVIEW' | 'LISTEN' | 'TASK' | 'REPEAT' | 'SESSION';

/** What finishes a session step: the session ending, the teacher's evaluation, or an evaluation that marks it mastered. */
export type SessionCompletion = 'ATTENDED' | 'EVALUATED' | 'MASTERED';

/** Each kind's own settings. A setting left out takes its default, so older tracks keep working unchanged. */
export interface WirdStepOptions {
  /** REVIEW, LISTEN, REPEAT and SESSION: the student may skip the step. Default false. */
  optional?: boolean;
  /** TASK: shows the button that opens the mushaf on today's portion. Default true. */
  showMushaf?: boolean;
  /** REVIEW: how many of the portions before today's are reviewed together, within the same surah. Default 1. */
  portions?: number;
  /** REPEAT: lets the student glance at the mushaf from the repetition screen. Default true. */
  allowPeek?: boolean;
  /** SESSION: what finishes it. Default EVALUATED. */
  completion?: SessionCompletion;
  /** SESSION: the student may confirm it herself, such as after reciting in person. Default false. */
  selfConfirm?: boolean;
}

export interface WirdStepDef {
  id: number;
  kind: WirdStepKind;
  title: string;
  subtitle: string;
  options?: WirdStepOptions;
}
/**
 * How a track's students recite to the teacher: in an online voice session, by a recording sent from the app,
 * or not at all. NONE leaves the session step out of the wird, so the rest of the steps carry on without it.
 */
export type RecitationMode = 'LIVE' | 'RECORDING' | 'NONE';

export interface WirdConfig {
  steps: WirdStepDef[];
  recitationMode: RecitationMode;
  repeatTarget: number;
  reviewTarget: number;
  listenTarget: number;
}
export interface WirdCounts {
  doneSteps: number[];
  repeatCount: number;
  reviewCount: number;
  listenCount: number;
}

/** A student's counts for a portion, from its progress row, or zero before there is one. */
export function wirdCountsOf(row: Partial<WirdCounts> | null | undefined): WirdCounts {
  return {
    doneSteps: row?.doneSteps ?? [],
    repeatCount: row?.repeatCount ?? 0,
    reviewCount: row?.reviewCount ?? 0,
    listenCount: row?.listenCount ?? 0,
  };
}

export const DEFAULT_WIRD_STEPS: WirdStepDef[] = [
  { id: 0, kind: 'REVIEW', title: 'تسميع الوجه السابق غيبًا', subtitle: '' },
  { id: 1, kind: 'LISTEN', title: 'سماع الشيخ لنصاب اليوم', subtitle: 'مع فتح المصحف' },
  { id: 2, kind: 'TASK', title: 'قراءة النصاب نظرًا حتى إتقانه', subtitle: 'قبل البدء بالحفظ' },
  { id: 3, kind: 'TASK', title: 'البدء بحفظ النصاب حتى التمكّن', subtitle: 'بعد إتقان القراءة نظرًا وتسميعها لشخص آخر' },
  { id: 6, kind: 'SESSION', title: 'جلسة تسميع صوتية مع المعلمة', subtitle: 'تسميع النصاب قبل تكراره غيبًا', options: { completion: 'EVALUATED' } },
  { id: 4, kind: 'REPEAT', title: 'تكرار النصاب غيبًا', subtitle: 'إجباري للحفظ الجديد' },
  { id: 5, kind: 'TASK', title: 'سرد وربط السورتين السابقتين', subtitle: 'مع النصاب الجديد' },
];

export function wirdConfigOf(template: {
  wirdSteps: unknown;
  recitationMode?: RecitationMode;
  repeatTarget: number;
  reviewTarget: number;
  listenTarget: number;
}): WirdConfig {
  const recitationMode = template.recitationMode ?? 'LIVE';
  const steps = (template.wirdSteps as WirdStepDef[] | null) ?? DEFAULT_WIRD_STEPS;
  return {
    // The step stays in the track, so switching back to a mode with recitation brings it back as it was.
    steps: recitationMode === 'NONE' ? steps.filter(({ kind }) => kind !== 'SESSION') : steps,
    recitationMode,
    repeatTarget: template.repeatTarget,
    reviewTarget: template.reviewTarget,
    listenTarget: template.listenTarget,
  };
}

/** A step's settings with every default filled in. */
export function stepOptions(step: Pick<WirdStepDef, 'options'> | null | undefined): Required<WirdStepOptions> {
  const options = step?.options ?? {};
  return {
    optional: options.optional ?? false,
    showMushaf: options.showMushaf ?? true,
    portions: Math.min(5, Math.max(1, options.portions ?? 1)),
    allowPeek: options.allowPeek ?? true,
    completion: options.completion ?? 'EVALUATED',
    selfConfirm: options.selfConfirm ?? false,
  };
}

/**
 * Something the teacher did: a voice session ended, or a recitation was evaluated. `via` says how the evaluated
 * recitation was heard: in a voice session, in a recording the student sent, or entered by the teacher directly.
 */
export type SessionEvent = { kind: 'ENDED' } | { kind: 'EVALUATED'; mastered: boolean; via: 'SESSION' | 'RECORDING' | 'DIRECT' };

/**
 * Whether something the teacher did finishes a session step that asks for `completion`, on a track that recites
 * by `mode`. A recording has no session to attend, so on a recording track only its evaluation counts, and
 * ATTENDED is read as EVALUATED.
 */
export function sessionEventFinishes(completion: SessionCompletion, event: SessionEvent, mode: RecitationMode = 'LIVE'): boolean {
  if (mode === 'NONE') return false;
  if (mode === 'RECORDING') {
    return event.kind === 'EVALUATED' && event.via === 'RECORDING' && (completion !== 'MASTERED' || event.mastered);
  }
  if (event.kind === 'ENDED') return completion === 'ATTENDED';
  return completion !== 'MASTERED' || event.mastered;
}

/** Whether the student may tick a step off with its button rather than its counter or the teacher. */
export function canSelfMark(step: WirdStepDef): boolean {
  const options = stepOptions(step);
  return step.kind === 'TASK' || options.optional || (step.kind === 'SESSION' && options.selfConfirm);
}

/**
 * The portions the review step goes over: up to `portions` of those just before `current`, kept within
 * the surah of the last one so the mushaf can open on them together.
 */
export function reviewRange<T extends Pick<PlanUnit, 'surah'>>(units: T[], current: number, portions: number): T[] {
  const last = units[current - 1];
  if (!last) return [];
  const range: T[] = [];
  for (let index = current - 1; index >= 0 && range.length < portions && units[index].surah === last.surah; index--) {
    range.unshift(units[index]);
  }
  return range;
}

/** The first portion has nothing before it, so there is nothing to review yet. A skippable step is done once skipped. */
export function isStepDone(step: WirdStepDef, counts: WirdCounts, config: WirdConfig, hasPrevious: boolean): boolean {
  if (step.kind !== 'TASK' && stepOptions(step).optional && counts.doneSteps.includes(step.id)) return true;
  if (step.kind === 'REPEAT') return counts.repeatCount >= config.repeatTarget;
  if (step.kind === 'LISTEN') return counts.listenCount >= config.listenTarget;
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
