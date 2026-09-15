/**
 * ISO 8601 week utilities — the single source of truth for week math.
 * ISO rules: weeks start Monday; week 1 contains the first Thursday of the year.
 */

/** Returns the ISO week number and ISO week-numbering year of a date. */
export function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday of the current ISO week decides the ISO year.
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to Thursday
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day);
  const week = Math.round(
    (d.getTime() - week1Monday.getTime()) / (7 * 24 * 3600 * 1000),
  ) + 1;
  return { year: isoYear, week };
}

/** Monday of ISO week `week` in `year` (UTC midnight). */
export function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

/** Number of ISO weeks in a year: 53 when Jan 1 is Thu, or leap year starting Wed. */
export function isoWeeksInYear(year: number): number {
  const dec28 = new Date(Date.UTC(year, 11, 28));
  return isoWeek(dec28).week;
}

/** ISO week range [start, end] as YYYY-MM-DD strings. */
export function isoWeekDates(year: number, week: number): { startDate: string; endDate: string } {
  const start = isoWeekStart(year, week);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}
