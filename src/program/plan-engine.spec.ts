import { SURAHS } from '../common/surahs.js';
import {
  convertCompletedUnits,
  canSelfMark,
  firstOpenStep,
  reviewRange,
  sessionEventFinishes,
  absenceLevel,
  buildSteps,
  buildUnits,
  buildWeek,
  computeProgress,
  computeStreak,
  countWirdDays,
  DEFAULT_WIRD_STEPS,
  delayLabel,
  dueUnitsToday,
  type PlanRules,
  projectFinish,
  sessionsOf,
  wirdConfigOf,
} from './plan-engine.js';

const WIRD = [0, 1, 2, 3, 4];
const ORDER = [...Array.from({ length: 97 }, (_, i) => i + 18), ...Array.from({ length: 17 }, (_, i) => i + 1)];
const page: PlanRules = { dailyUnit: 'PAGE', wirdDays: WIRD, consolidationDays: 1 };
const half: PlanRules = { ...page, dailyUnit: 'HALF_PAGE' };
const date = (value: string) => new Date(`${value}T00:00:00Z`);
// 8 November 2026 is a Sunday.
const SUNDAY = date('2026-11-08');

describe('buildUnits', () => {
  it('covers every ayah of the Quran exactly once, in order, whatever the unit', () => {
    for (const unit of ['HALF_PAGE', 'PAGE', 'SURAH'] as const) {
      const units = buildUnits(unit, ORDER);
      for (const surah of SURAHS) {
        const own = units.filter((item) => item.surah === surah.number);
        expect(own[0].fromAyah).toBe(1);
        expect(own.at(-1)!.toAyah).toBe(surah.ayahCount);
        for (let i = 1; i < own.length; i++) expect(own[i].fromAyah).toBe(own[i - 1].toAyah + 1);
        expect(own.filter((item) => item.lastOfSurah)).toHaveLength(1);
        expect(own.at(-1)!.lastOfSurah).toBe(true);
      }
    }
  });

  it('starts with the first surah in the track and keeps the index in step', () => {
    const units = buildUnits('PAGE', ORDER);
    expect(units[0].surah).toBe(18);
    expect(units.at(-1)!.surah).toBe(17);
    units.forEach((unit, index) => expect(unit.index).toBe(index));
  });

  it('gives a half-page track about twice the units of a page track', () => {
    const pages = buildUnits('PAGE', ORDER).length;
    const halves = buildUnits('HALF_PAGE', ORDER).length;
    expect(halves).toBeGreaterThan(pages * 1.7);
    expect(halves).toBeLessThanOrEqual(pages * 2);
  });

  it('gives one unit per surah for a surah-by-surah track', () => {
    expect(buildUnits('SURAH', ORDER)).toHaveLength(114);
  });

  it('counts ayahs a day over the whole Quran and over a juz range, each surah on its own', () => {
    const whole = buildUnits('AYAHS', ORDER, [], 7);
    for (const surah of SURAHS) {
      const own = whole.filter((item) => item.surah === surah.number);
      expect(own).toHaveLength(Math.ceil(surah.ayahCount / 7));
      expect(own.every((item) => item.toAyah - item.fromAyah + 1 <= 7)).toBe(true);
    }
    // Juz' 30 runs from page 582 to the end, starting inside An-Naba.
    const juz = buildUnits('AYAHS', ORDER, [582, 604], 5);
    expect(juz.length).toBeGreaterThan(0);
    expect(juz.every((item) => item.surah >= 78 && item.page >= 582)).toBe(true);
  });
});

describe('sessionsOf', () => {
  it('keeps the day whole without sessions', () => {
    expect(sessionsOf({ fromAyah: 1, toAyah: 10 }, null)).toEqual([]);
    expect(sessionsOf({ fromAyah: 1, toAyah: 10 }, 1)).toEqual([]);
  });

  it('splits the portion by ayahs, earlier sessions taking the extra', () => {
    expect(sessionsOf({ fromAyah: 11, toAyah: 17 }, 2)).toEqual([
      { number: 1, fromAyah: 11, toAyah: 14 },
      { number: 2, fromAyah: 15, toAyah: 17 },
    ]);
    const three = sessionsOf({ fromAyah: 1, toAyah: 10 }, 3);
    expect(three.map(({ fromAyah, toAyah }) => [fromAyah, toAyah])).toEqual([[1, 4], [5, 7], [8, 10]]);
  });

  it('has no more sessions than ayahs, and none for a single ayah', () => {
    expect(sessionsOf({ fromAyah: 5, toAyah: 6 }, 4)).toHaveLength(2);
    expect(sessionsOf({ fromAyah: 5, toAyah: 5 }, 3)).toEqual([]);
  });
});

describe('buildSteps', () => {
  it('adds consolidation days after each surah', () => {
    const units = buildUnits('SURAH', [112, 113]);
    expect(buildSteps(units, 2).map((step) => step.type)).toEqual(['unit', 'consolidation', 'consolidation', 'unit', 'consolidation', 'consolidation']);
    expect(buildSteps(units, 0).map((step) => step.type)).toEqual(['unit', 'unit']);
  });
});

describe('countWirdDays', () => {
  it('counts only wird days, both ends included', () => {
    expect(countWirdDays(SUNDAY, SUNDAY, WIRD)).toBe(1);
    expect(countWirdDays(SUNDAY, date('2026-11-12'), WIRD)).toBe(5);
    expect(countWirdDays(SUNDAY, date('2026-11-14'), WIRD)).toBe(5);
    expect(countWirdDays(SUNDAY, date('2026-11-21'), WIRD)).toBe(10);
    expect(countWirdDays(date('2026-11-13'), date('2026-11-14'), WIRD)).toBe(0);
    expect(countWirdDays(date('2026-11-10'), SUNDAY, WIRD)).toBe(0);
  });

  it('matches a day-by-day count over a long range', () => {
    const start = date('2026-11-11');
    let count = 0;
    for (let i = 0; i < 400; i++) {
      const day = new Date(start.getTime() + i * 86_400_000);
      if ([1, 3, 6].includes(day.getUTCDay())) count++;
      expect(countWirdDays(start, day, [1, 3, 6])).toBe(count);
    }
  });
});

describe('computeProgress', () => {
  const units = buildUnits('PAGE', ORDER);
  const position = (completedUnits: number, extra = {}) => ({ startOn: SUNDAY, completedUnits, creditedDays: 0, gateOpenedOn: null, ...extra });

  it('expects nothing before the start', () => {
    expect(computeProgress(units, page, position(0), date('2026-11-07'))).toMatchObject({ expectedUnits: 0, commitment: null, behindUnits: 0 });
  });

  it('is on track when the work matches the days', () => {
    const result = computeProgress(units, page, position(3), date('2026-11-11'));
    expect(result).toMatchObject({ expectedUnits: 3, behindUnits: 0, behindDays: 0, commitment: 100 });
    expect(delayLabel(result)).toBeNull();
  });

  it('does not count today as late while today is still going', () => {
    expect(computeProgress(units, page, position(0), SUNDAY)).toMatchObject({ expectedUnits: 0, behindUnits: 0, commitment: null });
    expect(computeProgress(units, page, position(0), date('2026-11-09'))).toMatchObject({ expectedUnits: 1, behindUnits: 1, commitment: 0 });
  });

  it('measures the delay', () => {
    const result = computeProgress(units, page, position(1), date('2026-11-12'));
    expect(result).toMatchObject({ expectedUnits: 4, behindUnits: 3, behindPages: 3, behindDays: 3, commitment: 25 });
    expect(delayLabel(result)).toBe('3 أيام · 3 أوجه');
  });

  it('counts half pages in a half-page track', () => {
    const halves = buildUnits('HALF_PAGE', ORDER);
    expect(computeProgress(halves, half, position(0), date('2026-11-10'))).toMatchObject({ behindUnits: 2, behindPages: 1 });
  });

  it('never goes over 100 when a student is ahead', () => {
    expect(computeProgress(units, page, position(10), date('2026-11-09'))).toMatchObject({ behindUnits: 0, commitment: 100 });
  });

  it('skips the weekend', () => {
    expect(computeProgress(units, page, position(5), date('2026-11-14'))).toMatchObject({ expectedUnits: 5, behindUnits: 0 });
  });

  it('expects nothing new on a consolidation day', () => {
    const short = buildUnits('SURAH', [112, 113]);
    const rules: PlanRules = { ...page, dailyUnit: 'SURAH' };
    // Sunday: 112. Monday: consolidation. Tuesday: 113.
    expect(computeProgress(short, rules, position(1), date('2026-11-10'))).toMatchObject({ expectedUnits: 1, behindUnits: 0 });
    expect(computeProgress(short, rules, position(1), date('2026-11-11'))).toMatchObject({ expectedUnits: 2, behindUnits: 1 });
  });

  it('stops the clock while a gate waits', () => {
    const stopped = position(2, { gateOpenedOn: date('2026-11-10') });
    expect(computeProgress(units, page, stopped, date('2026-11-25'))).toMatchObject({ expectedUnits: 2, behindUnits: 0 });
  });

  it('does not count credited waiting days', () => {
    const later = position(2, { creditedDays: 14 });
    expect(computeProgress(units, page, later, date('2026-11-24'))).toMatchObject({ expectedUnits: 2, behindUnits: 0 });
  });

  it('never expects more than the whole track', () => {
    const short = buildUnits('SURAH', [112]);
    const rules: PlanRules = { ...page, dailyUnit: 'SURAH' };
    expect(computeProgress(short, rules, position(1), date('2030-01-01'))).toMatchObject({ expectedUnits: 1, progress: 100, commitment: 100 });
  });
});

describe('dueUnitsToday', () => {
  const units = buildUnits('PAGE', ORDER);
  const position = (completedUnits: number, extra = {}) => ({ startOn: SUNDAY, completedUnits, creditedDays: 0, gateOpenedOn: null, ...extra });

  it("counts today's own portion", () => {
    expect(dueUnitsToday(units, page, position(0), SUNDAY)).toBe(1);
  });

  it('carries a missed wird day over to the next', () => {
    // Sunday missed: Monday's wird is Sunday's portion and Monday's.
    expect(dueUnitsToday(units, page, position(0), date('2026-11-09'))).toBe(2);
    expect(dueUnitsToday(units, page, position(0), date('2026-11-11'))).toBe(4);
  });

  it('adds nothing on a day off, so what is owed waits for the next wird day', () => {
    // Thursday is the last wird day of the week: Friday and Saturday owe the same five.
    expect(dueUnitsToday(units, page, position(0), date('2026-11-13'))).toBe(5);
    expect(dueUnitsToday(units, page, position(0), date('2026-11-14'))).toBe(5);
    expect(dueUnitsToday(units, page, position(0), date('2026-11-15'))).toBe(6);
  });

  it('stops the clock while a gate waits', () => {
    expect(dueUnitsToday(units, page, position(2, { gateOpenedOn: date('2026-11-10') }), date('2026-11-25'))).toBe(3);
  });

  it('reports progress through the whole track', () => {
    expect(computeProgress(units, page, position(Math.round(units.length / 2)), SUNDAY).progress).toBe(50);
  });
});

describe('buildWeek', () => {
  const units = buildUnits('PAGE', ORDER);
  const position = { startOn: SUNDAY, completedUnits: 1, creditedDays: 0, gateOpenedOn: null };

  it('shows the past as it happened and the future from where the student is', () => {
    const week = buildWeek(units, page, position, date('2026-11-10'), new Set(['2026-11-08']));
    expect(week.map((day) => [day.kind, day.state])).toEqual([
      ['memorize', 'done'],
      ['memorize', 'missed'],
      ['memorize', 'today'],
      ['memorize', 'upcoming'],
      ['memorize', 'upcoming'],
      ['review', 'upcoming'],
      ['review', 'upcoming'],
    ]);
    expect(week[2].label).toContain('الكهف');
    expect(week[2].label).toContain(`${units[1].fromAyah}-${units[1].toAyah}`);
    expect(week[3].label).toContain(`${units[2].fromAyah}-${units[2].toAyah}`);
  });

  it('shows the gate instead of new work while one waits', () => {
    const week = buildWeek(units, page, { ...position, gateOpenedOn: date('2026-11-09') }, date('2026-11-10'), new Set());
    expect(week[2].kind).toBe('gate');
    expect(week[3].kind).toBe('gate');
  });

  it('shows the track as finished after the last unit', () => {
    const week = buildWeek(units, page, { ...position, completedUnits: units.length }, date('2026-11-10'), new Set());
    expect(week[2].kind).toBe('finished');
  });

  it('marks days before the start', () => {
    const week = buildWeek(units, page, { ...position, startOn: date('2026-11-10'), completedUnits: 0 }, date('2026-11-10'), new Set());
    expect(week[0].kind).toBe('before_start');
    expect(week[2].state).toBe('today');
  });
});

describe('delayLabel', () => {
  it.each([
    [1, 0.5, 'يوم · نصف وجه'],
    [2, 1, 'يومان · وجه'],
    [2, 2, 'يومان · وجهان'],
    [5, 5, '5 أيام · 5 أوجه'],
    [12, 12, '12 يومًا · 12 وجهًا'],
  ])('describes %s days and %s pages', (behindDays, behindPages, expected) => {
    expect(delayLabel({ behindDays, behindPages })).toBe(expected);
  });

  it('is null with no delay', () => {
    expect(delayLabel({ behindDays: 0, behindPages: 0 })).toBeNull();
  });
});

describe('projectFinish', () => {
  const short = buildUnits('SURAH', [112, 113]);
  const rules: PlanRules = { dailyUnit: 'SURAH', wirdDays: WIRD, consolidationDays: 1 };

  it('counts the remaining wird days, including consolidation, and skips the weekend', () => {
    // Thursday: 112. Sunday: consolidation. Monday: 113. Tuesday: consolidation.
    const result = projectFinish(short, rules, 0, date('2026-11-12'));
    expect(result?.finishOn).toEqual(date('2026-11-17'));
    expect(result?.remainingDays).toBe(5);
  });

  it('is zero once everything is done', () => {
    expect(projectFinish(short, rules, 2, SUNDAY)?.remainingDays).toBe(0);
  });

  it('has no date for a track with no wird days', () => {
    expect(projectFinish(short, { ...rules, wirdDays: [] }, 0, SUNDAY)).toBeNull();
  });
});

describe('computeStreak', () => {
  it('counts back across the weekend, and today only once done', () => {
    const done = new Set(['2026-11-05', '2026-11-08', '2026-11-09']);
    expect(computeStreak(done, WIRD, date('2026-11-10'))).toBe(3);
    expect(computeStreak(new Set([...done, '2026-11-10']), WIRD, date('2026-11-10'))).toBe(4);
  });

  it('stops at a missed day', () => {
    expect(computeStreak(new Set(['2026-11-08']), WIRD, date('2026-11-10'))).toBe(0);
  });
});

describe('absenceLevel', () => {
  it.each([
    [['PRESENT', 'ABSENT'], null],
    [['ABSENT', 'PRESENT', 'ABSENT'], 1],
    [['ABSENT', 'ABSENT', 'ABSENT'], 2],
    [['ABSENT', 'PRESENT', 'ABSENT', 'ABSENT', 'ABSENT', 'PRESENT', 'ABSENT'], 3],
    [[], null],
  ])('reads %j as %s', (records, level) => {
    expect(absenceLevel(records)).toBe(level);
  });
});

describe('convertCompletedUnits', () => {
  const order = [18, 19];
  const half = buildUnits('HALF_PAGE', order);
  const page = buildUnits('PAGE', order);
  const surah = buildUnits('SURAH', order);

  it('counts nothing when nothing was done', () => {
    expect(convertCompletedUnits(half, page, 0)).toBe(0);
  });

  it('never counts a page that is only half done', () => {
    expect(convertCompletedUnits(half, page, 1)).toBe(0);
    expect(convertCompletedUnits(half, page, 2)).toBe(1);
  });

  it('keeps every part of a finished page when units shrink', () => {
    expect(convertCompletedUnits(page, half, 1)).toBe(2);
  });

  it('counts only whole surahs, and a finished track stays finished', () => {
    const kahf = surah[0];
    const lastOfKahf = page.filter((unit) => unit.surah === kahf.surah).length;
    expect(convertCompletedUnits(page, surah, lastOfKahf - 1)).toBe(0);
    expect(convertCompletedUnits(page, surah, lastOfKahf)).toBe(1);
    expect(convertCompletedUnits(page, surah, page.length)).toBe(surah.length);
  });
});

describe('the wird steps', () => {
  const config = { steps: DEFAULT_WIRD_STEPS, recitationMode: 'LIVE' as const, repeatTarget: 3, reviewTarget: 2, listenTarget: 2 };
  const counts = (doneSteps: number[] = [], repeatCount = 0, reviewCount = 0, listenCount = 0) => ({ doneSteps, repeatCount, reviewCount, listenCount });

  it('starts past the review when there is nothing before the first portion', () => {
    expect(firstOpenStep(counts(), config, false)?.id).toBe(1);
    expect(firstOpenStep(counts(), config, true)?.id).toBe(0);
  });

  it('finishes a counted step only at its target, however it was ticked', () => {
    expect(firstOpenStep(counts([0], 0, 1), config, true)?.id).toBe(0);
    expect(firstOpenStep(counts([], 0, 2), config, true)?.id).toBe(1);
    expect(firstOpenStep(counts([2, 3, 6, 4], 2, 2, 2), config, true)?.id).toBe(4);
  });

  it('waits on the teacher for the session step before the repetition', () => {
    expect(firstOpenStep(counts([2, 3], 3, 2, 2), config, true)?.id).toBe(6);
    expect(firstOpenStep(counts([2, 3, 6], 0, 2, 2), config, true)?.id).toBe(4);
  });

  it('finishes a session step by what its track counts', () => {
    expect(sessionEventFinishes('ATTENDED', { kind: 'ENDED' })).toBe(true);
    expect(sessionEventFinishes('EVALUATED', { kind: 'ENDED' })).toBe(false);
    expect(sessionEventFinishes('EVALUATED', { kind: 'EVALUATED', mastered: false, via: 'SESSION' })).toBe(true);
    expect(sessionEventFinishes('MASTERED', { kind: 'EVALUATED', mastered: false, via: 'SESSION' })).toBe(false);
    expect(sessionEventFinishes('MASTERED', { kind: 'EVALUATED', mastered: true, via: 'SESSION' })).toBe(true);
  });

  it('finishes a recording track’s session step only by an evaluated recording', () => {
    const recording = { kind: 'EVALUATED', mastered: false, via: 'RECORDING' } as const;
    expect(sessionEventFinishes('EVALUATED', recording, 'RECORDING')).toBe(true);
    // No session to attend: ATTENDED waits for the recording's evaluation instead.
    expect(sessionEventFinishes('ATTENDED', recording, 'RECORDING')).toBe(true);
    expect(sessionEventFinishes('ATTENDED', { kind: 'ENDED' }, 'RECORDING')).toBe(false);
    expect(sessionEventFinishes('EVALUATED', { ...recording, via: 'SESSION' }, 'RECORDING')).toBe(false);
    expect(sessionEventFinishes('EVALUATED', { ...recording, via: 'DIRECT' }, 'RECORDING')).toBe(false);
    expect(sessionEventFinishes('MASTERED', recording, 'RECORDING')).toBe(false);
    expect(sessionEventFinishes('MASTERED', { ...recording, mastered: true }, 'RECORDING')).toBe(true);
    expect(sessionEventFinishes('EVALUATED', recording, 'NONE')).toBe(false);
  });

  it('leaves the session step out of a track that recites by neither', () => {
    const template = { wirdSteps: null, repeatTarget: 3, reviewTarget: 2, listenTarget: 2 };
    expect(wirdConfigOf(template).steps.some(({ kind }) => kind === 'SESSION')).toBe(true);
    expect(wirdConfigOf({ ...template, recitationMode: 'RECORDING' }).steps.some(({ kind }) => kind === 'SESSION')).toBe(true);
    const none = wirdConfigOf({ ...template, recitationMode: 'NONE' });
    expect(none.steps.some(({ kind }) => kind === 'SESSION')).toBe(false);
    expect(none.steps).toHaveLength(DEFAULT_WIRD_STEPS.length - 1);
    // Without the teacher's step, repetition opens as soon as the memorizing is done.
    expect(firstOpenStep(counts([2, 3], 0, 2, 2), none, true)?.id).toBe(4);
  });

  it('lets a student mark only the steps her track allows', () => {
    const session = { id: 1, kind: 'SESSION' as const, title: '', subtitle: '' };
    expect(canSelfMark(session)).toBe(false);
    expect(canSelfMark({ ...session, options: { selfConfirm: true } })).toBe(true);
    expect(canSelfMark({ ...session, kind: 'REPEAT' })).toBe(false);
    expect(canSelfMark({ ...session, kind: 'REPEAT', options: { optional: true } })).toBe(true);
    expect(canSelfMark({ ...session, kind: 'TASK' })).toBe(true);
  });

  it('counts a skipped step done only when its track makes it optional', () => {
    const steps = [{ id: 7, kind: 'REPEAT' as const, title: '', subtitle: '', options: { optional: true } }];
    expect(firstOpenStep(counts([7]), { ...config, steps }, true)).toBeNull();
    expect(firstOpenStep(counts([7]), { ...config, steps: [{ ...steps[0], options: {} }] }, true)?.id).toBe(7);
  });

  it('reviews several portions before the current one, within one surah', () => {
    const units = [{ surah: 1 }, { surah: 2 }, { surah: 2 }, { surah: 2 }, { surah: 2 }];
    expect(reviewRange(units, 4, 2)).toEqual([units[2], units[3]]);
    expect(reviewRange(units, 2, 3)).toEqual([units[1]]);
    expect(reviewRange(units, 0, 3)).toEqual([]);
  });

  it('finishes listening only after the sheikh is heard as many times as the track asks', () => {
    expect(firstOpenStep(counts([1], 0, 2, 0), config, true)?.id).toBe(1);
    expect(firstOpenStep(counts([], 0, 2, 1), config, true)?.id).toBe(1);
    expect(firstOpenStep(counts([], 0, 2, 2), config, true)?.id).toBe(2);
  });

  it('leaves a task open until its own button is pressed', () => {
    expect(firstOpenStep(counts([], 3, 2, 2), config, true)?.id).toBe(2);
    expect(firstOpenStep(counts([2, 3, 6], 3, 2, 2), config, true)?.id).toBe(5);
    expect(firstOpenStep(counts([2, 3, 6, 5], 3, 2, 2), config, true)).toBeNull();
  });

  it('follows a track\'s own list and targets', () => {
    const custom = wirdConfigOf({
      wirdSteps: [{ id: 90, kind: 'TASK', title: 'مهمة', subtitle: '' }],
      repeatTarget: 1,
      reviewTarget: 1,
      listenTarget: 1,
    });
    expect(firstOpenStep(counts(), custom, true)?.id).toBe(90);
    expect(firstOpenStep(counts([90]), custom, true)).toBeNull();
    expect(wirdConfigOf({ wirdSteps: null, repeatTarget: 35, reviewTarget: 5, listenTarget: 1 }).steps).toBe(DEFAULT_WIRD_STEPS);
  });
});
