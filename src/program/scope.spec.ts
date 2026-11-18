import { describe, expect, it } from 'vitest';
import { buildUnits, unitLabel } from './plan-engine.js';
import { pageRangeFor, scopeLabel, surahOrderFor } from './scope.js';

describe('a track scope', () => {
  it('orders the surahs from Al-Baqarah or from the end', () => {
    expect(surahOrderFor('FORWARD').slice(0, 3)).toEqual([1, 2, 3]);
    expect(surahOrderFor('BACKWARD').slice(0, 4)).toEqual([1, 114, 113, 112]);
    expect(surahOrderFor('BACKWARD').at(-1)).toBe(2);
    for (const order of ['FORWARD', 'BACKWARD'] as const) expect(new Set(surahOrderFor(order)).size).toBe(114);
  });

  it('keeps only the chosen surahs, in the mushaf order whatever the direction or the order they were picked in', () => {
    expect(surahOrderFor('FORWARD', [68, 67, 1])).toEqual([1, 67, 68]);
    expect(surahOrderFor('BACKWARD', [67, 68, 1])).toEqual([1, 67, 68]);
  });

  it('begins at the start surah and comes round to the surahs before it', () => {
    const forward = surahOrderFor('FORWARD', [], 18);
    expect(forward.slice(0, 2)).toEqual([18, 19]);
    expect(forward.slice(-2)).toEqual([16, 17]);
    expect(new Set(forward).size).toBe(114);
    expect(surahOrderFor('BACKWARD', [], 67).slice(0, 3)).toEqual([67, 66, 65]);
    expect(surahOrderFor('BACKWARD', [], 67).slice(-2)).toEqual([69, 68]);
    expect(surahOrderFor('FORWARD', [1, 67, 68], 67)).toEqual([67, 68, 1]);
    // A surah outside the scope leaves the order as it is.
    expect(surahOrderFor('FORWARD', [67, 68], 2)).toEqual([67, 68]);
    expect(scopeLabel('FORWARD', null, null, [], 18)).toBe('القرآن كاملًا · تبدأ من الكهف');
  });

  it('splits chosen surahs into a set number of ayahs a day, the last day taking what remains', () => {
    // Al-Mulk has 30 ayahs: four days of 7, then 2.
    const units = buildUnits('AYAHS', surahOrderFor('FORWARD', [67]), [], 7);
    expect(units.map(({ fromAyah, toAyah }) => [fromAyah, toAyah])).toEqual([[1, 7], [8, 14], [15, 21], [22, 28], [29, 30]]);
    expect(units.at(-1)).toMatchObject({ lastOfSurah: true });
    expect(units.filter((unit) => unit.lastOfSurah)).toHaveLength(1);
    // Together the days cover the surah's pages, each day on the page it starts on.
    expect(units.reduce((sum, unit) => sum + unit.pages, 0)).toBeCloseTo(buildUnits('PAGE', [67]).length, 1);
    expect(units[0].page).toBe(562);
    expect(unitLabel(units[0], 'AYAHS')).toBe('الملك · 1-7');

    // A day never runs from one surah into the next.
    const two = buildUnits('AYAHS', [112, 113], [], 10);
    expect(two.map(({ surah, fromAyah, toAyah }) => [surah, fromAyah, toAyah])).toEqual([[112, 1, 4], [113, 1, 5]]);
  });

  it('turns a juz range into its pages', () => {
    expect(pageRangeFor(null, null)).toEqual([]);
    expect(pageRangeFor(1, 1)).toEqual([1, 21]);
    expect(pageRangeFor(26, 30)).toEqual([502 + 1, 604]);
  });

  it('memorizes only the pages of the range, in the track order', () => {
    const forward = buildUnits('PAGE', surahOrderFor('FORWARD'), pageRangeFor(30, 30));
    expect(forward[0]).toMatchObject({ surah: 78, fromAyah: 1, page: 582 });
    expect(forward.at(-1)).toMatchObject({ surah: 114, lastOfSurah: true });

    const backward = buildUnits('PAGE', surahOrderFor('BACKWARD'), pageRangeFor(30, 30));
    expect(backward[0].surah).toBe(114);
    expect(backward.at(-1)!.surah).toBe(78);
  });

  it('memorizes a surah the range cuts through only in part, and says so', () => {
    const [first] = buildUnits('SURAH', surahOrderFor('FORWARD'), pageRangeFor(27, 27));
    expect(first).toMatchObject({ surah: 51, fromAyah: 31 });
    expect(unitLabel(first, 'SURAH')).toBe('الذاريات · 31-60');
    expect(unitLabel(buildUnits('SURAH', [112])[0], 'SURAH')).toBe('الإخلاص');
  });

  it('keeps the whole Quran when there is no range', () => {
    expect(buildUnits('SURAH', surahOrderFor('FORWARD'))).toHaveLength(114);
  });

  it('names the scope', () => {
    expect(scopeLabel('FORWARD', null, null)).toBe('القرآن كاملًا · من البقرة');
    expect(scopeLabel('BACKWARD', 26, 30)).toBe('الأجزاء 26–30 (5 أجزاء) · من آخر المصحف');
    expect(scopeLabel('FORWARD', 30, 30)).toBe('الجزء 30 · من البقرة');
    expect(scopeLabel('FORWARD', 29, 30)).toBe('الأجزاء 29–30 (جزآن) · من البقرة');
    expect(scopeLabel('BACKWARD', null, null, [67, 68])).toBe('الملك، القلم');
    expect(scopeLabel('FORWARD', null, null, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe('12 سورة مختارة');
  });
});
