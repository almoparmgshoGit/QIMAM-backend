import { SURAHS } from '../common/surahs.js';
import type { MemorizationOrder } from '../generated/prisma/enums.js';

/** The page each juz' begins on in the Madinah mushaf, juz' 1 first. The same table the app reads. */
export const JUZ_START_PAGES = [
  1, 22, 42, 63, 82, 102, 122, 142, 162, 182, 202, 222, 242, 262, 282, 302, 322, 342, 362, 382, 402, 422, 442, 462, 482, 503, 522,
  542, 562, 582,
];
const LAST_PAGE = 604;

const ALL_SURAHS = Array.from({ length: 114 }, (_, index) => index + 1);

/**
 * The order a track memorizes in.
 * FORWARD: Al-Fatiha, then Al-Baqarah on to An-Nas.
 * BACKWARD: Al-Fatiha, then An-Nas back to Al-Baqarah. Each surah is still memorized from its first ayah.
 * Chosen surahs have no direction: they go in the mushaf's order, whatever the track's order says.
 */
export function surahOrderFor(order: MemorizationOrder, selected: number[] = [], startSurah: number | null = null): number[] {
  const surahs =
    selected.length > 0 ? [...new Set(selected)].sort((a, b) => a - b) : order === 'FORWARD' ? ALL_SURAHS : [1, ...ALL_SURAHS.slice(1).reverse()];
  // A start surah turns the order round to begin there; the surahs before it come at the end.
  const from = startSurah === null ? 0 : Math.max(surahs.indexOf(startSurah), 0);
  return [...surahs.slice(from), ...surahs.slice(0, from)];
}

/** The first and last page of a juz' range, or empty for the whole Quran. */
export function pageRangeFor(juzFrom: number | null, juzTo: number | null): number[] {
  if (juzFrom === null || juzTo === null) return [];
  return [JUZ_START_PAGES[juzFrom - 1], juzTo === 30 ? LAST_PAGE : JUZ_START_PAGES[juzTo] - 1];
}

const ORDER_LABEL: Record<MemorizationOrder, string> = {
  FORWARD: 'من البقرة',
  BACKWARD: 'من آخر المصحف',
};

/** Arabic counted nouns: one, two, 3–10 take the plural, 11 and up take the singular accusative. */
function counted(count: number, [one, two, few, many]: [string, string, string, string]): string {
  if (count === 1) return one;
  if (count === 2) return two;
  return `${count} ${count <= 10 ? few : many}`;
}

/** What a track covers: «القرآن كاملًا», «الأجزاء 26–30 (5 أجزاء)», «الملك، القلم، الحاقة» or «12 سورة مختارة». */
function scopeOf(juzFrom: number | null, juzTo: number | null, selected: number[]): string {
  if (selected.length > 0) {
    return selected.length <= 3
      ? surahOrderFor('FORWARD', selected).map((surah) => SURAHS[surah - 1].name).join('، ')
      : `${counted(selected.length, ['سورة', 'سورتان', 'سور', 'سورة'])} مختارة`;
  }
  if (juzFrom === null || juzTo === null) return 'القرآن كاملًا';
  if (juzFrom === juzTo) return `الجزء ${juzFrom}`;
  return `الأجزاء ${juzFrom}–${juzTo} (${counted(juzTo - juzFrom + 1, ['جزء', 'جزآن', 'أجزاء', 'جزءًا'])})`;
}

/** «القرآن كاملًا · من البقرة», «الأجزاء 26–30 (5 أجزاء) · من آخر المصحف», «الملك، القلم». Chosen surahs have no direction. */
export function scopeLabel(
  order: MemorizationOrder,
  juzFrom: number | null,
  juzTo: number | null,
  selected: number[] = [],
  startSurah: number | null = null,
): string {
  const scope = scopeOf(juzFrom, juzTo, selected);
  const start = startSurah === null ? null : `تبدأ من ${SURAHS[startSurah - 1].name}`;
  if (selected.length > 0) return start ? `${scope} · ${start}` : scope;
  return `${scope} · ${start ?? ORDER_LABEL[order]}`;
}
