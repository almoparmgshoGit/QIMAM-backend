import { describe, expect, it } from 'vitest';
import { countMarks, emptyCounts, examScore, itemScore, type ScoringRules } from './stage-exam-scoring.js';

const RULES: ScoringRules = { deductions: { HIFZ: 1, PROMPT: 0.5, HESITATION: 0.25, TAJWEED: 0.25 }, minSurahs: 3, passScore: 7 };

describe('stage exam scoring', () => {
  it('takes each mistake off a surah\'s 10, by its kind', () => {
    expect(itemScore(emptyCounts(), RULES.deductions)).toBe(10);
    const counts = countMarks([{ kind: 'HIFZ' }, { kind: 'HIFZ' }, { kind: 'PROMPT' }, { kind: 'TAJWEED' }]);
    expect(counts).toEqual({ HIFZ: 2, PROMPT: 1, HESITATION: 0, TAJWEED: 1 });
    expect(itemScore(counts, RULES.deductions)).toBe(7.25);
  });

  it('never goes below zero', () => {
    expect(itemScore({ ...emptyCounts(), HIFZ: 15 }, RULES.deductions)).toBe(0);
  });

  it('scores the exam by the mean of its surahs, and passes at the pass score', () => {
    const perfect = emptyCounts();
    const weak = { ...emptyCounts(), HIFZ: 5 };
    expect(examScore([perfect, perfect, weak], RULES)).toEqual({ score: 8.3, passed: true });
    expect(examScore([weak, weak, perfect], RULES)).toEqual({ score: 6.7, passed: false });
    expect(examScore([{ ...emptyCounts(), HIFZ: 3 }], RULES)).toEqual({ score: 7, passed: true });
    expect(examScore([], RULES)).toBeNull();
  });
});
