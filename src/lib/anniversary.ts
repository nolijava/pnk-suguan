/** Age from birthday — always derived, never stored as authoritative. */
export function calculateAge(birthday: Date | string, now: Date = new Date()): number {
  const b = typeof birthday === "string" ? new Date(`${birthday}T00:00:00Z`) : birthday;
  if (Number.isNaN(b.getTime())) throw new Error("invalid birthday");
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < b.getUTCMonth() ||
    (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

/** Years/months since a past date (for "inactive for X" displays). */
export function elapsedSince(date: Date | string, now: Date = new Date()): { years: number; months: number } {
  const d = typeof date === "string" ? new Date(`${date}T00:00:00Z`) : date;
  if (Number.isNaN(d.getTime())) throw new Error("invalid date");
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  let months = now.getUTCMonth() - d.getUTCMonth();
  if (now.getUTCDate() < d.getUTCDate()) months--;
  if (months < 0) { years--; months += 12; }
  return { years, months };
}

export type AnniversaryStage =
  | "ONE_MONTH_BEFORE"
  | "APPROACHING"
  | "ONE_DAY_BEFORE"
  | "TODAY";

/** Next anniversary of a date and days from `now` (negative = already passed this year). */
export function nextAnniversary(
  dateEstablished: Date | string,
  now: Date = new Date(),
): { date: Date; daysUntil: number; anniversaryYear: number } {
  const d = typeof dateEstablished === "string" ? new Date(`${dateEstablished}T00:00:00Z`) : dateEstablished;
  if (Number.isNaN(d.getTime())) throw new Error("invalid date");
  const year = now.getUTCFullYear();
  let ann = new Date(Date.UTC(year, d.getUTCMonth(), d.getUTCDate()));
  // Handle Feb 29 establishments.
  if (ann.getUTCMonth() !== d.getUTCMonth()) ann = new Date(Date.UTC(year, d.getUTCMonth() + 1, 0));
  const daysUntil = Math.round((ann.getTime() - utcMidnight(now)) / 86_400_000);
  if (daysUntil < 0) {
    // Next year's occurrence. Feb 29 convention: in a non-leap anniversary year the
    // celebration falls on Feb 28 (Date.UTC clamps the same way).
    let nextYearAnn = new Date(Date.UTC(year + 1, d.getUTCMonth(), d.getUTCDate()));
    if (nextYearAnn.getUTCMonth() !== d.getUTCMonth()) {
      nextYearAnn = new Date(Date.UTC(year + 1, d.getUTCMonth() + 1, 0)); // Feb 28 convention
    }
    // Exact day difference — no 365/isLeap arithmetic (leap-year safe).
    const daysUntilNext = Math.round((nextYearAnn.getTime() - utcMidnight(now)) / 86_400_000);
    return { date: nextYearAnn, daysUntil: daysUntilNext, anniversaryYear: year + 1 };
  }
  return { date: ann, daysUntil, anniversaryYear: year };
}

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Which notification stage applies on `now` for an anniversary. */
export function anniversaryStage(dateEstablished: Date | string, now: Date = new Date()): AnniversaryStage | null {
  const { date: ann, daysUntil } = nextAnniversary(dateEstablished, now);
  if (daysUntil === 0) return "TODAY";
  if (daysUntil === 1) return "ONE_DAY_BEFORE";
  // Exactly one calendar month before the anniversary (month-aware, not 30/31 days).
  // Checked before APPROACHING so the boundary day gets the more specific stage.
  const oneMonthBefore = new Date(ann);
  oneMonthBefore.setUTCMonth(oneMonthBefore.getUTCMonth() - 1);
  const nowMid = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (oneMonthBefore.getTime() === nowMid.getTime()) return "ONE_MONTH_BEFORE";
  if (daysUntil <= 30) return "APPROACHING";
  return null;
}
