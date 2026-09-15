import { describe, it, expect } from "vitest";
import { calculateAge, elapsedSince, anniversaryStage, nextAnniversary } from "@/lib/anniversary";

describe("age calculation (§9)", () => {
  const now = new Date("2026-09-15T00:00:00Z");
  it("computes age from birthday", () => {
    expect(calculateAge("1990-09-15", now)).toBe(36);
    expect(calculateAge("1990-09-16", now)).toBe(35); // birthday tomorrow
    expect(calculateAge("2000-02-29", now)).toBe(26); // leap-day baby
  });
});

describe("inactive elapsed (§14)", () => {
  const now = new Date("2026-09-15T00:00:00Z");
  it("computes years/months since date_inactive", () => {
    expect(elapsedSince("2025-09-15", now)).toEqual({ years: 1, months: 0 });
    expect(elapsedSince("2026-08-20", now)).toEqual({ years: 0, months: 0 });
    expect(elapsedSince("2024-03-01", now)).toEqual({ years: 2, months: 6 });
  });
});

describe("anniversary (§12/§28)", () => {
  const now = new Date("2026-09-15T00:00:00Z"); // anniversary date 2011-09-15 → today
  it("flags TODAY on the anniversary", () => {
    expect(anniversaryStage("2011-09-15", now)).toBe("TODAY");
  });
  it("flags ONE_DAY_BEFORE", () => {
    expect(anniversaryStage("2011-09-16", now)).toBe("ONE_DAY_BEFORE");
  });
  it("flags ONE_MONTH_BEFORE", () => {
    expect(anniversaryStage("2011-10-15", now)).toBe("ONE_MONTH_BEFORE");
  });
  it("flags APPROACHING within 30 days", () => {
    expect(anniversaryStage("2011-10-01", now)).toBe("APPROACHING");
    expect(anniversaryStage("2011-10-14", now)).toBe("APPROACHING");
  });
  it("returns null outside the window", () => {
    expect(anniversaryStage("2011-12-25", now)).toBeNull();
  });
  it("wraps to next year after the date passed", () => {
    const r = nextAnniversary("2011-01-10", now);
    expect(r.anniversaryYear).toBe(2027);
    expect(r.daysUntil).toBeGreaterThan(100);
  });
});

describe("anniversary leap-year edge cases (§16 — Feb 29 convention)", () => {
  // Convention: a Feb-29 establishment celebrates on Feb 28 in non-leap years.
  it("maps Feb-29 establishment to Feb 28 in a non-leap anniversary year", () => {
    const now = new Date("2027-02-15T00:00:00Z");
    const r = nextAnniversary("2004-02-29", now);
    expect(r.date.toISOString().slice(0, 10)).toBe("2027-02-28");
    expect(r.daysUntil).toBe(13); // exact calendar count, not 365 arithmetic
    expect(r.anniversaryYear).toBe(2027);
  });

  it("keeps Feb 29 itself in a leap anniversary year", () => {
    const now = new Date("2028-02-10T00:00:00Z");
    const r = nextAnniversary("2004-02-29", now);
    expect(r.date.toISOString().slice(0, 10)).toBe("2028-02-29");
    expect(r.daysUntil).toBe(19);
  });

  it("treats the clamped Feb 28 as the anniversary day (TODAY) in non-leap years", () => {
    const now = new Date("2027-02-28T00:00:00Z");
    const r = nextAnniversary("2004-02-29", now);
    expect(r.daysUntil).toBe(0);
    expect(anniversaryStage("2004-02-29", now)).toBe("TODAY");
  });

  it("counts exactly 365 days across a year containing a leap day (no off-by-one)", () => {
    const now = new Date("2027-03-01T00:00:00Z");
    const r = nextAnniversary("2004-02-29", now);
    // 2027-03-01 → 2028-02-29: 365 days (2028's leap day is the target itself)
    expect(r.daysUntil).toBe(365);
    expect(r.anniversaryYear).toBe(2028);
  });

  it("wraps after a leap-year Feb 29 has passed to the next non-leap Feb 28", () => {
    const now = new Date("2028-03-05T00:00:00Z");
    const r = nextAnniversary("2004-02-29", now);
    expect(r.date.toISOString().slice(0, 10)).toBe("2029-02-28");
    expect(r.daysUntil).toBe(360);
    expect(r.anniversaryYear).toBe(2029);
  });
});
