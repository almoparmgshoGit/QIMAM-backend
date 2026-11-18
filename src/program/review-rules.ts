import { seventhLabel } from '../common/sevenths.js';
import type { ReviewEndRule, ReviewFinalKind } from '../generated/prisma/enums.js';

// The rules of a review track, as pure functions over dates, so each can be tested directly.
// All dates are date-only values at UTC midnight, as the plan's are.

/** The day a review that began on `startOn` ends, `months` later. A day past the month's end falls on its last day. */
export function reviewEndsOnFor(startOn: Date, months: number | null): Date | null {
  if (months === null) return null;
  const year = startOn.getUTCFullYear();
  const month = startOn.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(startOn.getUTCDate(), lastDay)));
}

export interface ReviewState {
  rule: ReviewEndRule;
  /** Null when the track has no duration, so only the scope can end it. */
  endsOn: Date | null;
  scopeDone: boolean;
}

/** Whether the review is over, so the student may ask for the final test. */
export function reviewFinished({ rule, endsOn, scopeDone }: ReviewState, today: Date): boolean {
  const timeUp = endsOn !== null && today >= endsOn;
  if (rule === 'DURATION') return timeUp;
  if (rule === 'SCOPE') return scopeDone;
  return timeUp || scopeDone;
}

export const FINAL_LABELS: Record<ReviewFinalKind, string> = {
  RECITATION: 'التسميع الختامي',
  EXAM: 'الاختبار الختامي',
};

/** «السُّبع الثالث», or «التسميع الختامي» for a review track's final test, which has no seventh. */
export const examLabel = (stage: number, finalKind: ReviewFinalKind | null) => (finalKind ? FINAL_LABELS[finalKind] : seventhLabel(stage));
