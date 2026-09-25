/**
 * Update #24 — the `?fix=1` deep link on the Weekly Availability page.
 *
 * The blocked-week marks and the generation block notices land on
 * `/availability?year=&week=&fix=1`, which switches the page into the
 * “fix availability” guide. That parameter therefore rides on the STRICT
 * availability query schema, and a strict schema has a sharp edge here: the
 * page parses with `safeParse` and falls back to “no filters at all” when it
 * fails, so an unrecognised or hand-typed value would silently throw away the
 * operator's active filters mid-remediation.
 *
 * Pinned here: `fix` is accepted (and any value the link might carry), it
 * travels ALONGSIDE the real filters rather than replacing them, the guide is
 * only ON for the two documented values, and `.strict()` still rejects genuinely
 * unknown keys.
 */
import { describe, it, expect } from "vitest";
import {
  availabilityQuerySchema,
  AVAILABILITY_FILTER_KEYS,
  FIX_PARAM_VALUES,
} from "@/lib/validation/query-schemas";

const WEEK_ID = "11111111-1111-4111-8111-111111111111";

describe("Update #24 — availability `fix` parameter", () => {
  it("accepts the fix deep link and keeps the other filters", () => {
    const parsed = availabilityQuerySchema.safeParse({
      weekId: WEEK_ID,
      fix: "1",
      availability: "NOT_ENCODED",
      q: "alfa",
      sort: "name",
      order: "asc",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      fix: "1",
      availability: "NOT_ENCODED",
      q: "alfa",
      sort: "name",
      order: "asc",
    });
  });

  it("never rejects the query for an unexpected fix value (that would drop every filter)", () => {
    for (const value of ["1", "true", "yes", "0", "", "anything"]) {
      const parsed = availabilityQuerySchema.safeParse({ weekId: WEEK_ID, fix: value, q: "keep-me" });
      expect(parsed.success, `fix=${value}`).toBe(true);
      expect(parsed.success && parsed.data.q, `fix=${value}`).toBe("keep-me");
    }
  });

  it("turns the guide on only for the documented values", () => {
    expect(FIX_PARAM_VALUES).toEqual(["1", "true"]);
    for (const value of ["1", "true", "yes", "0"]) {
      const on = (FIX_PARAM_VALUES as readonly string[]).includes(value);
      expect(on, `fix=${value}`).toBe(value === "1" || value === "true");
    }
  });

  it("keeps the strict contract for genuinely unknown keys", () => {
    expect(availabilityQuerySchema.safeParse({ weekId: WEEK_ID, nope: "1" }).success).toBe(false);
    // A missing weekId is still invalid — `fix` never stands in for the week.
    expect(availabilityQuerySchema.safeParse({ fix: "1" }).success).toBe(false);
  });

  it("exposes exactly the filter keys the page may forward (drift guard)", () => {
    const shapeKeys = Object.keys(availabilityQuerySchema.shape);
    expect(shapeKeys).toContain("weekId");
    expect([...AVAILABILITY_FILTER_KEYS].sort()).toEqual(
      shapeKeys.filter((k) => k !== "weekId").sort(),
    );
  });

  it("proves WHY the page must forward only those keys: the page-owned params fail the strict parse", () => {
    // This is the bug the page now avoids — `year`/`week` (week navigation) and
    // `notice`/`error` (redirect flags) are not filter parameters, and the page
    // falls back to NO filters at all when the parse fails.
    for (const extra of [{ year: "2026" }, { week: "39" }, { notice: "saved" }, { error: "nope" }]) {
      expect(availabilityQuerySchema.safeParse({ ...extra, weekId: WEEK_ID, availability: "NOT_ENCODED" }).success).toBe(false);
    }
    // Forwarding only the filter keys keeps them — the fixed behaviour.
    const forwarded: Record<string, string> = {};
    const flat: Record<string, string> = { year: "2026", week: "39", availability: "NOT_ENCODED" };
    for (const key of AVAILABILITY_FILTER_KEYS) if (flat[key] !== undefined) forwarded[key] = flat[key]!;
    const parsed = availabilityQuerySchema.safeParse({ ...forwarded, weekId: WEEK_ID });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.availability).toBe("NOT_ENCODED");
    expect(parsed.success && "year" in parsed.data).toBe(false);
  });
});
