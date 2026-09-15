import { describe, it, expect } from "vitest";
import { isoWeek, isoWeeksInYear, isoWeekDates, isoWeekStart } from "@/lib/iso-week";

describe("ISO 8601 weeks", () => {
  it("maps known dates correctly", () => {
    expect(isoWeek(new Date("2026-01-01"))).toEqual({ year: 2026, week: 1 });
    expect(isoWeek(new Date("2024-12-30"))).toEqual({ year: 2025, week: 1 }); // Mon 30 Dec 2024 is ISO 2025-W01
    expect(isoWeek(new Date("2026-09-15"))).toEqual({ year: 2026, week: 38 });
  });

  it("counts 53 weeks in 2020 and 2026, 52 otherwise", () => {
    expect(isoWeeksInYear(2020)).toBe(53);
    expect(isoWeeksInYear(2026)).toBe(53);
    expect(isoWeeksInYear(2021)).toBe(52);
    expect(isoWeeksInYear(2025)).toBe(52);
  });

  it("week start is a Monday and end is Sunday", () => {
    const { startDate, endDate } = isoWeekDates(2026, 38);
    expect(new Date(`${startDate}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(new Date(`${endDate}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(endDate > startDate).toBe(true);
  });

  it("isoWeekStart matches isoWeek round-trip", () => {
    for (let w = 1; w <= isoWeeksInYear(2026); w++) {
      const s = isoWeekStart(2026, w);
      expect(isoWeek(s)).toEqual({ year: 2026, week: w });
    }
  });
});
