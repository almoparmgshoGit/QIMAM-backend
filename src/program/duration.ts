/** Arabic counted nouns: one, two, 3–10 take the plural, 11 and up take the singular accusative. */
function counted(count: number, [one, two, few, many]: [string, string, string, string]): string {
  if (count === 1) return one;
  if (count === 2) return two;
  return `${count} ${count <= 10 ? few : many}`;
}

/** A track's length in words, as students read it: «سنة و5 أشهر», «3 سنوات», «8 أشهر». */
export function formatDuration(totalMonths: number): string {
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const parts = [
    years > 0 ? counted(years, ['سنة', 'سنتان', 'سنوات', 'سنة']) : '',
    months > 0 ? counted(months, ['شهر', 'شهران', 'أشهر', 'شهرًا']) : '',
  ].filter(Boolean);
  return parts.join(' و');
}
