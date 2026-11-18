import { describe, expect, it } from 'vitest';
import { buildUnits } from '../program/plan-engine.js';
import { pageRangeFor, surahOrderFor } from '../program/scope.js';
import { SURAH_PAGES } from './mushaf.js';
import { seventhLabel, seventhOf, seventhsFinished, surahsOfSeventh } from './sevenths.js';

describe('the sevenths of the Quran', () => {
  it('starts each seventh at «فمي بشوق» when divided by surahs', () => {
    expect(seventhOf({ surah: 4, page: 106 }, 'SURAHS')).toBe(1);
    expect(seventhOf({ surah: 5, page: 106 }, 'SURAHS')).toBe(2);
    expect(seventhOf({ surah: 49, page: 515 }, 'SURAHS')).toBe(6);
    expect(seventhOf({ surah: 50, page: 518 }, 'SURAHS')).toBe(7);
    expect(seventhOf({ surah: 114, page: 604 }, 'SURAHS')).toBe(7);
  });

  it('cuts the mushaf into seven parts of about 86 pages when divided by pages', () => {
    expect(seventhOf({ surah: 2, page: 86 }, 'PAGES')).toBe(1);
    expect(seventhOf({ surah: 2, page: 87 }, 'PAGES')).toBe(2);
    expect(seventhOf({ surah: 114, page: 604 }, 'PAGES')).toBe(7);
  });

  it('finishes a seventh at its last unit, forward and backward', () => {
    const forward = buildUnits('PAGE', surahOrderFor('FORWARD'));
    const endOfFirst = forward.findLastIndex((unit) => unit.surah === 4);
    expect(seventhsFinished(forward, endOfFirst, endOfFirst + 1, 'SURAHS')).toEqual([1]);
    expect(seventhsFinished(forward, endOfFirst - 1, endOfFirst, 'SURAHS')).toEqual([]);
    expect(seventhsFinished(forward, 0, forward.length, 'SURAHS')).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // From the end: Al-Fatiha, then An-Nas back to Qaf finishes the seventh seventh, but not the first.
    const backward = buildUnits('PAGE', surahOrderFor('BACKWARD'));
    const afterQaf = backward.findLastIndex((unit) => unit.surah === 50) + 1;
    expect(seventhsFinished(backward, 0, afterQaf, 'SURAHS')).toEqual([7]);
    expect(seventhsFinished(backward, 0, backward.length, 'SURAHS').at(-1)).toBe(1);
  });

  it('finishes the part of a seventh a juz range holds', () => {
    const juzAmma = buildUnits('PAGE', surahOrderFor('FORWARD'), pageRangeFor(30, 30));
    expect(seventhsFinished(juzAmma, 0, juzAmma.length, 'SURAHS')).toEqual([7]);
    expect(seventhsFinished(juzAmma, 0, juzAmma.length - 1, 'SURAHS')).toEqual([]);
  });

  it('lists the surahs of a seventh', () => {
    expect(surahsOfSeventh(1, 'SURAHS', SURAH_PAGES)).toEqual([1, 2, 3, 4]);
    expect(surahsOfSeventh(7, 'SURAHS', SURAH_PAGES)).toHaveLength(65);
    // An-Nisa, pages 77 to 106, runs from the first seventh by pages into the second, so both hold it.
    expect(surahsOfSeventh(1, 'PAGES', SURAH_PAGES)).toEqual([1, 2, 3, 4]);
    expect(surahsOfSeventh(2, 'PAGES', SURAH_PAGES)[0]).toBe(4);
  });

  it('names a seventh', () => {
    expect(seventhLabel(3)).toBe('السُّبع الثالث');
  });
});
