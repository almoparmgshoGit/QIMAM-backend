import type { StageExamMarkKind } from '../generated/prisma/enums.js';

// How a stage exam is scored: each surah the student recited starts at 10 and loses what each mistake costs,
// never going below zero, and the exam's score is the mean of its surahs. Pure, so every rule is tested directly.

export const MARK_KINDS = ['HIFZ', 'PROMPT', 'HESITATION', 'TAJWEED'] as const satisfies readonly StageExamMarkKind[];

export const MARK_LABELS: Record<StageExamMarkKind, string> = {
  HIFZ: 'خطأ حفظ',
  PROMPT: 'تنبيه',
  HESITATION: 'تردد',
  TAJWEED: 'خطأ تجويد',
};

export const ITEM_MAX = 10;

export interface ScoringRules {
  /** What each mistake takes off a surah's 10. */
  deductions: Record<StageExamMarkKind, number>;
  /** The fewest surahs an exam needs before it can be scored. */
  minSurahs: number;
  /** Out of 10. */
  passScore: number;
}

export type MarkCounts = Record<StageExamMarkKind, number>;

export const emptyCounts = (): MarkCounts => ({ HIFZ: 0, PROMPT: 0, HESITATION: 0, TAJWEED: 0 });

export function countMarks(marks: { kind: StageExamMarkKind }[]): MarkCounts {
  const counts = emptyCounts();
  for (const { kind } of marks) counts[kind] += 1;
  return counts;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** A surah's score out of 10, to two places. */
export function itemScore(counts: MarkCounts, deductions: ScoringRules['deductions']): number {
  const lost = MARK_KINDS.reduce((sum, kind) => sum + counts[kind] * deductions[kind], 0);
  return round(Math.max(0, ITEM_MAX - lost), 2);
}

/** The exam's score out of 10, to one place as results are kept, and whether it passes. Null with no surahs. */
export function examScore(items: MarkCounts[], rules: ScoringRules): { score: number; passed: boolean } | null {
  if (items.length === 0) return null;
  const mean = items.reduce((sum, counts) => sum + itemScore(counts, rules.deductions), 0) / items.length;
  const score = round(mean, 1);
  return { score, passed: score >= rules.passScore };
}
