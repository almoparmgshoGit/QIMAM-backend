import { reviewEndsOnFor, reviewFinished } from './review-rules.js';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('reviewEndsOnFor', () => {
  it('adds whole months', () => {
    expect(reviewEndsOnFor(day('2026-01-15'), 3)).toEqual(day('2026-04-15'));
    expect(reviewEndsOnFor(day('2026-11-10'), 2)).toEqual(day('2027-01-10'));
  });
  it('keeps to the last day of a shorter month', () => {
    expect(reviewEndsOnFor(day('2026-01-31'), 1)).toEqual(day('2026-02-28'));
  });
  it('has no end without a duration', () => {
    expect(reviewEndsOnFor(day('2026-01-31'), null)).toBeNull();
  });
});

describe('reviewFinished', () => {
  const today = day('2026-05-01');
  it('by duration waits for the end date, whatever the scope', () => {
    expect(reviewFinished({ rule: 'DURATION', endsOn: day('2026-05-02'), scopeDone: true }, today)).toBe(false);
    expect(reviewFinished({ rule: 'DURATION', endsOn: day('2026-05-01'), scopeDone: false }, today)).toBe(true);
  });
  it('by scope waits for the scope, whatever the date', () => {
    expect(reviewFinished({ rule: 'SCOPE', endsOn: day('2026-01-01'), scopeDone: false }, today)).toBe(false);
    expect(reviewFinished({ rule: 'SCOPE', endsOn: null, scopeDone: true }, today)).toBe(true);
  });
  it('either takes whichever comes first', () => {
    expect(reviewFinished({ rule: 'EITHER', endsOn: day('2026-06-01'), scopeDone: true }, today)).toBe(true);
    expect(reviewFinished({ rule: 'EITHER', endsOn: day('2026-04-01'), scopeDone: false }, today)).toBe(true);
    expect(reviewFinished({ rule: 'EITHER', endsOn: day('2026-06-01'), scopeDone: false }, today)).toBe(false);
  });
});
