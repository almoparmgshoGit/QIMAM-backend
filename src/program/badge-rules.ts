import type { BadgeTrigger } from '../generated/prisma/enums.js';

/** What a student has done so far, measured the way automatic badges count it. */
export interface BadgeMetrics {
  /** Surah gates passed. Skipped surahs don't count. */
  surahsPassed: number;
  /** Pages the student memorized herself or recited to her teacher. Skipped units don't count. */
  pages: number;
  /** Days on which at least one unit of the wird was done. */
  wirdDays: number;
  /** 0 to 100. */
  trackProgress: number;
  trackCompleted: boolean;
}

export const EMPTY_METRICS: BadgeMetrics = { surahsPassed: 0, pages: 0, wirdDays: 0, trackProgress: 0, trackCompleted: false };

/** Triggers that wait for a count. TRACK_COMPLETED waits for the whole track instead. */
export const COUNTED_TRIGGERS: readonly BadgeTrigger[] = ['SURAH_PASSED', 'PAGES_MEMORIZED', 'WIRD_DAYS'];

/** How far a student is towards an automatic badge, or null for a badge given by hand. */
export function badgeProgress(
  trigger: BadgeTrigger,
  threshold: number | null,
  metrics: BadgeMetrics,
): { current: number; target: number } | null {
  switch (trigger) {
    case 'SURAH_PASSED':
      return { current: metrics.surahsPassed, target: threshold ?? 1 };
    case 'PAGES_MEMORIZED':
      return { current: Math.floor(metrics.pages), target: threshold ?? 1 };
    case 'WIRD_DAYS':
      return { current: metrics.wirdDays, target: threshold ?? 1 };
    case 'TRACK_COMPLETED':
      return { current: metrics.trackCompleted ? 100 : Math.min(metrics.trackProgress, 99), target: 100 };
    default:
      return null;
  }
}

export function badgeReached(trigger: BadgeTrigger, threshold: number | null, metrics: BadgeMetrics): boolean {
  if (trigger === 'TRACK_COMPLETED') return metrics.trackCompleted;
  const progress = badgeProgress(trigger, threshold, metrics);
  return progress !== null && progress.current >= progress.target;
}

/** Arabic counted nouns: «سورة واحدة», «سورتين», «3 سور», «11 سورة». */
function counted(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  const lastTwo = n % 100;
  if (lastTwo >= 3 && lastTwo <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** The condition shown to students when the administrator leaves it empty. */
export function describeTrigger(trigger: BadgeTrigger, threshold: number | null): string | null {
  const n = threshold ?? 1;
  switch (trigger) {
    case 'SURAH_PASSED':
      return `اجتياز بوابة ${counted(n, 'سورة واحدة', 'سورتين', 'سور', 'سورة')}`;
    case 'PAGES_MEMORIZED':
      return `حفظ ${counted(n, 'صفحة واحدة', 'صفحتين', 'صفحات', 'صفحة')}`;
    case 'WIRD_DAYS':
      return `إتمام الورد في ${counted(n, 'يوم واحد', 'يومين', 'أيام', 'يومًا')}`;
    case 'TRACK_COMPLETED':
      return 'إتمام المسار كاملًا';
    default:
      return null;
  }
}
