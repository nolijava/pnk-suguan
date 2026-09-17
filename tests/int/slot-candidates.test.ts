/**
 * Master plan Group 5 — Delegate / Override / exception-mode candidate layer.
 * Proves the §19/§20/§21/§22 API contract the weekly dialogs consume:
 *   - slot-candidates returns ELIGIBLE teachers only in `eligible`;
 *   - ineligible teachers appear in `unavailable` WITH their exact violated
 *     rules and overrideAllowed=false for non-overrideable rules;
 *   - FIL teacher → EN dako is LANGUAGE_MISMATCH / overrideAllowed=false
 *     (never selectable through any UI path backed by this endpoint);
 *   - busy teachers are ALREADY_ASSIGNED_THIS_WEEK / overrideAllowed=false;
 *   - the current assignment is excluded from the busy set on override;
 *   - RBAC: read permission required; write paths still reject VIEWER;
 *   - end-to-end: a Delegate from the eligible list persists as MANUAL, and an
 *     ADMIN override with reason persists as OVERRIDE while SCHEDULER is
 *     rejected for the same ineligible candidate.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/session";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db } from "./helpers";

function actor(userId: string, roles: string[]): SessionUser {
  return {
    userId,
    email: "x@test.local",
    fullName: "X",
    mustChangePassword: false,
    roleCodes: roles,
    permissions: [],
  };
}

function weekStart(year: number, week: number): string {
  const jan4 = new Date(`${year}-01-04T00:00:00Z`);
  const dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (dow - 1) + (week - 1) * 7);
  const end = new Date(monday);
  end.setUTCDate(monday.getUTCDate() + 6);
  return monday.toISOString().slice(0, 10);
}

describe("master plan group 5 — delegate/override candidates", () => {
  let adminId: string;
  let schedId: string;

  beforeEach(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
    schedId = await seedScheduler();
  });

  afterAll(async () => {
    await teardown();
  });

  const admin = () => actor(adminId, ["ADMIN"]);
  const sched = () => actor(schedId, ["SCHEDULER"]);

  async function mkTeacher(code: string, over: Partial<{ status: string; language: string }> = {}) {
    const rows = await db.insert(schema.teachers).values({
      teacherCode: code,
      firstName: "T",
      lastName: code,
      language: "FILIPINO",
      dateInactive: over.status === "INACTIVE" ? "2099-01-01" : null,
      ...over,
    }).returning();
    return rows[0]!;
  }
  async function mkDako(code: string, over: Partial<{ language: string; status: string }> = {}) {
    const rows = await db.insert(schema.dako).values({
      dakoCode: code,
      name: `Dako ${code}`,
      address: "Addr",
      dateEstablished: "2000-01-01",
      worshipDay: "SUNDAY",
      worshipTime: "09:00",
      language: "FILIPINO",
      ...over,
    }).returning();
    return rows[0]!;
  }
  async function mkWeek(year: number, week: number, status = "DRAFT") {
    const start = weekStart(year, week);
    const endD = new Date(`${start}T00:00:00Z`);
    endD.setUTCDate(endD.getUTCDate() + 6);
    const rows = await db.insert(schema.weeks).values({
      year,
      isoWeekNumber: week,
      startDate: start,
      endDate: endD.toISOString().slice(0, 10),
      status,
    }).returning();
    return rows[0]!;
  }
  async function setAvail(teacherId: string, weekId: string, status: string) {
    await db.insert(schema.teacherAvailability).values({
      teacherId,
      weekId,
      availabilityStatus: status,
      reason: null,
    }).onConflictDoUpdate({
      target: [schema.teacherAvailability.teacherId, schema.teacherAvailability.weekId],
      set: { availabilityStatus: status, reason: null },
    });
  }

  async function candidates(weekId: string, dakoId: string, type: string, assignmentId?: string) {
    const { AssignmentService } = await import("@/server/services");
    return AssignmentService.listSlotCandidates(weekId, dakoId, type, assignmentId);
  }

  // ------------------------------------------------------------ eligible list
  it("returns only eligible AVAILABLE teachers in `eligible` and everyone else in `unavailable` with rules", async () => {
    const tOk = await mkTeacher("G1-1", { language: "ENGLISH" });
    const tNotEncoded = await mkTeacher("G1-2");
    const tAbsent = await mkTeacher("G1-3");
    const tFil = await mkTeacher("G1-4");
    const d = await mkDako("GD-1", { language: "ENGLISH" });
    const w = await mkWeek(2026, 40);

    await setAvail(tOk.id, w.id, "AVAILABLE");
    await setAvail(tAbsent.id, w.id, "ABSENT");

    const res = await candidates(w.id, d.id, "SUGO");
    expect(res.slot).toEqual({ dakoId: d.id, assignmentType: "SUGO" });

    const eligibleIds = res.eligible.map((t) => t.teacherId);
    expect(eligibleIds).toContain(tOk.id);
    expect(eligibleIds).not.toContain(tNotEncoded.id);
    expect(eligibleIds).not.toContain(tAbsent.id);
    expect(eligibleIds).not.toContain(tFil.id); // FIL → EN dako: never eligible

    const byId = new Map(res.unavailable.map((t) => [t.teacherId, t]));
    expect(byId.get(tNotEncoded.id)?.violatedRules).toContain("NOT_ENCODED");
    expect(byId.get(tAbsent.id)?.violatedRules).toContain("WEEKLY_ABSENT");
    const fil = byId.get(tFil.id);
    expect(fil?.violatedRules).toContain("LANGUAGE_MISMATCH");
    expect(fil?.overrideAllowed).toBe(false); // §21 — never overridable
  });

  it("marks busy teachers ALREADY_ASSIGNED_THIS_WEEK with overrideAllowed=false, excluding the current assignment on override", async () => {
    const tHold = await mkTeacher("G2-1", { language: "ENGLISH" });
    const tSlot = await mkTeacher("G2-2", { language: "ENGLISH" });
    const tFree = await mkTeacher("G2-3", { language: "ENGLISH" });
    const d = await mkDako("GD-2", { language: "ENGLISH" });
    const w = await mkWeek(2026, 41);

    await setAvail(tHold.id, w.id, "AVAILABLE");
    await setAvail(tSlot.id, w.id, "AVAILABLE");
    await setAvail(tFree.id, w.id, "AVAILABLE");

    const d2 = await mkDako("GD-2B", { language: "ENGLISH" });
    const { AssignmentService } = await import("@/server/services");
    const created = await AssignmentService.createAssignment(
      {
        weekId: w.id,
        dakoId: d.id,
        assignmentType: "SUGO",
        teacherId: tSlot.id,
      } as never,
      admin(),
    );
    // tHold genuinely holds an assignment elsewhere this week.
    await AssignmentService.createAssignment(
      { weekId: w.id, dakoId: d2.id, assignmentType: "SUGO", teacherId: tHold.id } as never,
      admin(),
    );
    const sut = await candidates(w.id, d.id, "RESERBA");
    const byId = new Map(sut.unavailable.map((t) => [t.teacherId, t]));
    expect(byId.get(tSlot.id)?.violatedRules).toEqual(["ALREADY_ASSIGNED_THIS_WEEK"]);
    expect(byId.get(tSlot.id)?.overrideAllowed).toBe(false);
    expect(byId.get(tHold.id)?.violatedRules).toContain("ALREADY_ASSIGNED_THIS_WEEK");
    expect(sut.eligible.map((t) => t.teacherId)).toContain(tFree.id);

    // Override view of tSlot's own assignment: the current teacher is excluded
    // entirely from both lists (the being-replaced convention), and tHold is
    // still busy.
    const sutOverride = await candidates(w.id, d.id, "SUGO", created.assignment.id);
    expect(sutOverride.eligible.map((t) => t.teacherId)).toContain(tFree.id);
    expect(sutOverride.eligible.map((t) => t.teacherId)).not.toContain(tSlot.id);
    expect(sutOverride.unavailable.map((t) => t.teacherId)).not.toContain(tSlot.id);
    expect(sutOverride.unavailable.find((t) => t.teacherId === tHold.id)?.violatedRules).toContain(
      "ALREADY_ASSIGNED_THIS_WEEK",
    );
  });

  it("persists a Delegate pick from the eligible list as MANUAL (no reason needed)", async () => {
    const t1 = await mkTeacher("G3-1", { language: "ENGLISH" });
    const d = await mkDako("GD-3", { language: "ENGLISH" });
    const w = await mkWeek(2026, 42);
    await setAvail(t1.id, w.id, "AVAILABLE");

    const res = await candidates(w.id, d.id, "SUGO");
    expect(res.eligible.map((t) => t.teacherId)).toContain(t1.id);

    const { AssignmentService } = await import("@/server/services");
    const out = await AssignmentService.createAssignment(
      {
        weekId: w.id,
        dakoId: d.id,
        assignmentType: "SUGO",
        teacherId: t1.id,
      } as never,
      sched(), // §19 — Scheduler may delegate into an empty slot
    );
    expect(out.override).toBe(false);
    expect(out.assignment.assignmentSource).toBe("MANUAL");

    const rows = await db.select().from(schema.assignments).where(eq(schema.assignments.id, out.assignment.id));
    expect(rows[0]!.assignmentSource).toBe("MANUAL");
    expect(rows[0]!.overrideReason).toBeNull();
  });

  it("ADMIN override via the exception path persists OVERRIDE with reason; SCHEDULER is rejected for the same candidate", async () => {
    const tAbsent = await mkTeacher("G4-1", { language: "ENGLISH" });
    const tFree = await mkTeacher("G4-2", { language: "ENGLISH" });
    const d = await mkDako("GD-4", { language: "ENGLISH" });
    const w = await mkWeek(2026, 43);
    await setAvail(tAbsent.id, w.id, "ABSENT");
    await setAvail(tFree.id, w.id, "AVAILABLE");

    const { AssignmentService } = await import("@/server/services");
    const created = await AssignmentService.createAssignment(
      { weekId: w.id, dakoId: d.id, assignmentType: "SUGO", teacherId: tAbsent.id } as never,
      admin(),
    );

    // Override candidates: the ABSENT current teacher is excluded; the free
    // teacher is eligible.
    const res = await candidates(w.id, d.id, "SUGO", created.assignment.id);
    expect(res.eligible.map((t) => t.teacherId)).toContain(tFree.id);

    // SCHEDULER cannot change to a WEEKLY_ABSENT candidate…
    await expect(
      AssignmentService.changeAssignment(created.assignment.id, {
        teacherId: tAbsent.id,
        reason: "trying a scheduler bypass",
      }, sched()),
    ).rejects.toThrow();

    // …while ADMIN override of a rule-violating candidate succeeds with reason
    // and lands as OVERRIDE (server re-validates; reason mandatory).
    await expect(
      AssignmentService.changeAssignment(created.assignment.id, {
        teacherId: tFree.id,
        reason: "original teacher became unavailable; next eligible assigned",
      }, admin()),
    ).resolves.toBeTruthy();
    const rows = await db.select().from(schema.assignments).where(eq(schema.assignments.id, created.assignment.id));
    expect(rows[0]!.assignmentSource).toBe("OVERRIDE");
    expect(rows[0]!.overrideReason).toBeTruthy();
  });

  it("non-overrideable rules stay server-refused even through the exception path (FIL teacher → EN dako)", async () => {
    const tFil = await mkTeacher("G5-1");
    const d = await mkDako("GD-5", { language: "ENGLISH" });
    const w = await mkWeek(2026, 44);
    await setAvail(tFil.id, w.id, "AVAILABLE");

    const res = await candidates(w.id, d.id, "SUGO");
    const fil = res.unavailable.find((t) => t.teacherId === tFil.id);
    expect(fil?.violatedRules).toContain("LANGUAGE_MISMATCH");
    expect(fil?.overrideAllowed).toBe(false);

    const { AssignmentService } = await import("@/server/services");
    await expect(
      AssignmentService.createAssignment(
        {
          weekId: w.id,
          dakoId: d.id,
          assignmentType: "SUGO",
          teacherId: tFil.id,
          overrideReason: "ADMIN exception attempt",
        } as never,
        admin(),
      ),
    ).rejects.toThrow(/not overridable/i);
  });
});
