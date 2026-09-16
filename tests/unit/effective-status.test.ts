/**
 * Phase 3 §8 — effective-availability precedence matrix (unit).
 * MASTER INACTIVE > WEEKLY INACTIVE > WEEKLY ABSENT > WEEKLY AVAILABLE;
 * no record = NOT_ENCODED. Master-INACTIVE can NEVER be schedulable.
 */
import { describe, it, expect } from "vitest";
import { resolveEffectiveStatus } from "@/server/services/availability.service";

describe("resolveEffectiveStatus precedence (§8/§14)", () => {
  it("master-INACTIVE dominates every weekly value", () => {
    for (const weekly of [null, undefined, "AVAILABLE", "ABSENT", "INACTIVE"]) {
      expect(resolveEffectiveStatus(weekly, "INACTIVE")).toBe("INACTIVE_MASTER");
    }
  });

  it("weekly INACTIVE beats ABSENT and AVAILABLE for master-ACTIVE teachers", () => {
    expect(resolveEffectiveStatus("INACTIVE", "ACTIVE")).toBe("INACTIVE_WEEKLY");
  });

  it("weekly ABSENT beats AVAILABLE for master-ACTIVE teachers", () => {
    expect(resolveEffectiveStatus("ABSENT", "ACTIVE")).toBe("ABSENT");
  });

  it("weekly AVAILABLE is only eligible when master-ACTIVE", () => {
    expect(resolveEffectiveStatus("AVAILABLE", "ACTIVE")).toBe("AVAILABLE");
  });

  it("no record = NOT_ENCODED (never a scheduling candidate)", () => {
    expect(resolveEffectiveStatus(null, "ACTIVE")).toBe("NOT_ENCODED");
    expect(resolveEffectiveStatus(undefined, "ACTIVE")).toBe("NOT_ENCODED");
  });
});
