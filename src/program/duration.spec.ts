import { describe, expect, it } from 'vitest';
import { formatDuration } from './duration.js';

describe('a track duration in words', () => {
  it('names whole years', () => {
    expect(formatDuration(12)).toBe('سنة');
    expect(formatDuration(24)).toBe('سنتان');
    expect(formatDuration(36)).toBe('3 سنوات');
    expect(formatDuration(132)).toBe('11 سنة');
  });

  it('names months alone', () => {
    expect(formatDuration(1)).toBe('شهر');
    expect(formatDuration(2)).toBe('شهران');
    expect(formatDuration(8)).toBe('8 أشهر');
  });

  it('joins years and the months left over', () => {
    expect(formatDuration(17)).toBe('سنة و5 أشهر');
    expect(formatDuration(54)).toBe('4 سنوات و6 أشهر');
    expect(formatDuration(25)).toBe('سنتان وشهر');
  });
});
