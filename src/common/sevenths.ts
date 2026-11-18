// The Quran in seven portions (أسباع), as the administration chooses to divide it.

export type SeventhDivision = 'SURAHS' | 'PAGES';

/** «فمي بشوق»: each seventh starts at one of these surahs. */
export const SEVENTH_START_SURAHS = [1, 5, 10, 17, 26, 37, 50] as const;

/** The 604-page mushaf in seven near-equal parts, by the page each starts on. */
export const SEVENTH_START_PAGES = [1, 87, 173, 259, 346, 432, 518] as const;

export const SEVENTH_NAMES = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع'];

/** «السُّبع الثالث». */
export const seventhLabel = (stage: number) => `السُّبع ${SEVENTH_NAMES[stage - 1] ?? stage}`;

const lastStartAtOrBefore = (starts: readonly number[], value: number) => {
  let stage = 1;
  for (let index = 0; index < starts.length; index++) if (value >= starts[index]) stage = index + 1;
  return stage;
};

/** The seventh, 1 to 7, a portion of memorization belongs to: by its surah, or by the page it starts on. */
export function seventhOf(unit: { surah: number; page: number }, division: SeventhDivision): number {
  return division === 'SURAHS' ? lastStartAtOrBefore(SEVENTH_START_SURAHS, unit.surah) : lastStartAtOrBefore(SEVENTH_START_PAGES, unit.page);
}

/**
 * The sevenths a student finished by going from `before` units done to `after`: those whose last unit in the plan
 * falls between. A plan that holds only part of a seventh, as a juz' range does, finishes it at its own last unit.
 * In the order they were finished.
 */
export function seventhsFinished(units: { surah: number; page: number }[], before: number, after: number, division: SeventhDivision): number[] {
  const lastIndex = new Map<number, number>();
  units.forEach((unit, index) => lastIndex.set(seventhOf(unit, division), index));
  return [...lastIndex]
    .filter(([, index]) => index >= before && index < after)
    .sort(([, a], [, b]) => a - b)
    .map(([stage]) => stage);
}

/**
 * The surahs a seventh holds, in order: those whose start falls in it by surahs, or any of whose pages do by pages,
 * so a surah cut across two sevenths belongs to both.
 */
export function surahsOfSeventh(stage: number, division: SeventhDivision, surahPages: Record<number, [number, number, number, number][]>): number[] {
  const surahs: number[] = [];
  for (let surah = 1; surah <= 114; surah++) {
    const inside =
      division === 'SURAHS'
        ? seventhOf({ surah, page: 0 }, 'SURAHS') === stage
        : surahPages[surah].some(([page]) => seventhOf({ surah, page }, 'PAGES') === stage);
    if (inside) surahs.push(surah);
  }
  return surahs;
}
