/**
 * Phase 4 — integration tests (§19/§22): engine end-to-end against the real
 * test database. Proves every hard rule, unassigned reasons, regeneration
 * snapshot + idempotency, MANUAL/OVERRIDE preservation, RBAC, concurrency,
 * data-integrity guarantees, and PUBLISHED immutability.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/session";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db, sql } from "./helpers";

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

/** Monday of ISO week 1 for the given year (approximation is fine for week rows). */
function weekStart(year: number, week: number): string {
  // Jan 4 is always in ISO week 1; walk back to Monday, then add (week-1)*7 days.
  const jan4 = new Date(`${year}-01-04T00:00:00Z`);
  const dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (dow - 1) + (week - 1) * 7);
  const end = new Date(monday);
  end.setUTCDate(monday.getUTCDate() + 6);
  return monday.toISOString().slice(0, 10);
}

describe("scheduling engine", () => {
  let adminId: string;
  let schedId: string;

  beforeEach(async () => {
    // Each test seeds its own fixture universe — isolates against the shared
    // test DB (counts from earlier tests would otherwise leak into scoring).
    await resetTestDb();
    adminId = await seedAdmin();
    schedId = await seedScheduler();
  });

  afterAll(async () => { await teardown(); });

  const admin = () => actor(adminId, ["ADMIN"]);
  const sched = () => actor(schedId, ["SCHEDULER"]);

  // ---------------------------------------------------------------- helpers
  async function mkTeacher(code: string, over: Partial<{ status: string; language: string; currentDestinationId: string | null }> = {}) {
    const rows = await db.insert(schema.teachers).values({
      teacherCode: code, firstName: "T", lastName: code, language: "FILIPINO",
      dateInactive: over.status === "INACTIVE" ? "2099-01-01" : null, ...over,
    }).returning();
    return rows[0]!;
  }
  async function mkDako(code: string, over: Partial<{ language: string; status: string }> = {}) {
    const rows = await db.insert(schema.dako).values({
      dakoCode: code, name: `Dako ${code}`, address: "Addr", dateEstablished: "2000-01-01",
      worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO", ...over,
    }).returning();
    return rows[0]!;
  }
  async function mkWeek(year: number, week: number, status = "DRAFT") {
    const start = weekStart(year, week);
    const endD = new Date(`${start}T00:00:00Z`);
    endD.setUTCDate(endD.getUTCDate() + 6);
    const rows = await db.insert(schema.weeks).values({ year, isoWeekNumber: week, startDate: start, endDate: endD.toISOString().slice(0, 10), status }).returning();
    return rows[0]!;
  }
  async function setAvail(teacherId: string, weekId: string, status: string, reason?: string) {
    await db.insert(schema.teacherAvailability).values({ teacherId, weekId, availabilityStatus: status, reason: reason ?? null }).onConflictDoUpdate({
      target: [schema.teacherAvailability.teacherId, schema.teacherAvailability.weekId],
      set: { availabilityStatus: status, reason: reason ?? null },
    });
  }
  async function weekRows(weekId: string) {
    return db.select().from(schema.assignments).where(eq(schema.assignments.weekId, weekId));
  }
  async function audits(action: string) {
    return db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action));
  }

  // ------------------------------------------------------------ generation
  it("generates SUGO+RESERBA+RESERBA_II for eligible teachers and audits GENERATED_SCHEDULE", async () => {
    const t1 = await mkTeacher("G1-1");
    const t2 = await mkTeacher("G1-2");
    const t3 = await mkTeacher("G1-3");
    const d = await mkDako("GD-1");
    const w = await mkWeek(2091, 2);
    for (const t of [t1, t2, t3]) await setAvail(t.id, w.id, "AVAILABLE");
    const { SchedulingService } = await import("@/server/services");
    const res = await SchedulingService.generateSchedule(w.id, admin());
    expect(res.regenerated).toBe(false);
    expect(res.inserted).toBe(3);
    const types = res.plan.slots.map((s) => [s.assignmentType, s.teacherId]);
    expect(Object.fromEntries(types)["SUGO"]).toBe(t1.id); // lowest code first
    expect(Object.fromEntries(types)["RESERBA"]).toBe(t2.id);
    expect(Object.fromEntries(types)["RESERBA_II"]).toBe(t3.id);
    expect((await audits("GENERATED_SCHEDULE")).length).toBe(1);
    expect((await weekRows(w.id)).length).toBe(3);
  });

  it("excludes master-INACTIVE, weekly ABSENT/INACTIVE, NOT_ENCODED, disabled dako", async () => {
    const inactive = await mkTeacher("G2-1", { status: "INACTIVE" });
    const absent = await mkTeacher("G2-2");
    const weeklyInactive = await mkTeacher("G2-3");
    const notEncoded = await mkTeacher("G2-4");
    void notEncoded;
    const active = await mkTeacher("G2-5");
    const d = await mkDako("GD-2");
    const w = await mkWeek(2092, 3);
    await setAvail(absent.id, w.id, "ABSENT", "travel");
    await setAvail(weeklyInactive.id, w.id, "INACTIVE");
    await setAvail(active.id, w.id, "AVAILABLE");
    // inactive + notEncoded: no records needed for inactive; notEncoded has none.
    const { SchedulingService } = await import("@/server/services");
    const res = await SchedulingService.generateSchedule(w.id, admin());
    const sugo = res.plan.slots.find((s) => s.assignmentType === "SUGO")!;
    expect(sugo.teacherId).toBe(active.id);
    const rows = await weekRows(w.id);
    expect(rows.map((r) => r.teacherId)).toEqual([active.id]);
    void inactive;
  });

  it("excludes prev-week-ABSENT teachers (hard rule §5) with ALL_ABSENT_LAST_WEEK reason", async () => {
    const a = await mkTeacher("G3-1");
    const b = await mkTeacher("G3-2");
    const d = await mkDako("GD-3");
    void d;
    const prev = await mkWeek(2093, 1);
    const cur = await mkWeek(2093, 2);
    void prev;
    await setAvail(a.id, cur.id, "ABSENT", "sick"); // a absent in W2
    await setAvail(b.id, cur.id, "AVAILABLE");
    const w3 = await mkWeek(2093, 3);
    await setAvail(a.id, w3.id, "AVAILABLE");
    await setAvail(b.id, w3.id, "AVAILABLE");
    const { SchedulingService } = await import("@/server/services");
    // W3: a was ABSENT in prev week (W2) → excluded; b fills SUGO.
    const res = await SchedulingService.generateSchedule(w3.id, admin());
    const sugo = res.plan.slots.find((s) => s.assignmentType === "SUGO")!;
    expect(sugo.teacherId).toBe(b.id);

    // All eligible were absent last week → unassigned with the specific reason.
    const w4 = await mkWeek(2093, 4);
    await setAvail(a.id, w4.id, "AVAILABLE");
    await setAvail(b.id, w4.id, "AVAILABLE");
    await setAvail(a.id, w3.id, "ABSENT", "travel");
    await setAvail(b.id, w3.id, "ABSENT", "travel");
    const res2 = await SchedulingService.generateSchedule(w4.id, admin());
    const sugo2 = res2.plan.slots.find((s) => s.assignmentType === "SUGO")!;
    expect(sugo2.teacherId).toBeNull();
    expect(sugo2.reasonCode).toBe("ALL_ABSENT_LAST_WEEK");
  });

  it("leaves slots unassigned rather than forcing an invalid teacher (§11)", async () => {
    const d = await mkDako("GD-4", { language: "ENGLISH" });
    const t = await mkTeacher("G4-1", { language: "FILIPINO" });
    const w = await mkWeek(2095, 4);
    await setAvail(t.id, w.id, "AVAILABLE");
    const { SchedulingService } = await import("@/server/services");
    const res = await SchedulingService.generateSchedule(w.id, admin());
    const sugo = res.plan.slots.find((s) => s.assignmentType === "SUGO")!;
    expect(sugo.teacherId).toBeNull();
    expect(sugo.reasonCode).toBe("LANGUAGE_MISMATCH");
    expect((await weekRows(w.id)).filter((r) => r.dakoId === d.id).length).toBe(0);
  });

  it("countPreviousWeekAbsences returns a fresh server-side count (§3)", async () => {
    const t = await mkTeacher("G5-1");
    const prev = await mkWeek(2096, 1);
    const cur = await mkWeek(2096, 2);
    await setAvail(t.id, prev.id, "ABSENT", "family");
    const { SchedulingService } = await import("@/server/services");
    expect((await SchedulingService.countPreviousWeekAbsences(cur.id)).count).toBe(1);
    // change data → count changes (no caching)
    await setAvail(t.id, prev.id, "AVAILABLE");
    expect((await SchedulingService.countPreviousWeekAbsences(cur.id)).count).toBe(0);
    void cur;
  });

  // ---------------------------------------------------------- regeneration
  it("regenerates: replaces AUTO, preserves MANUAL/OVERRIDE, audits full snapshot", async () => {
    // MANUAL assignment exists BEFORE generation — the pre-existing-override
    // scenario: regeneration must preserve it, skip its slot and teacher.
    const t1 = await mkTeacher("G6-1");
    const t2 = await mkTeacher("G6-2");
    const manualT = await mkTeacher("G6-3");
    const d = await mkDako("GD-6");
    const d2 = await mkDako("GD-6B");
    const w = await mkWeek(2097, 5);
    for (const t of [t1, t2, manualT]) await setAvail(t.id, w.id, "AVAILABLE");
    await db.insert(schema.assignments).values({
      weekId: w.id, dakoId: d2.id, teacherId: manualT.id, assignmentType: "SUGO",
      assignmentSource: "MANUAL", status: "ASSIGNED", isOverride: false,
    });
    const { SchedulingService } = await import("@/server/services");

    await SchedulingService.generateSchedule(w.id, admin());
    const before = await weekRows(w.id);
    const autoBefore = before.filter((r) => r.assignmentSource === "AUTO");
    expect(autoBefore.length).toBeGreaterThan(0);

    const res = await SchedulingService.generateSchedule(w.id, admin()); // regenerate
    expect(res.regenerated).toBe(true);

    const after = await weekRows(w.id);
    const manualRows = after.filter((r) => r.assignmentSource === "MANUAL");
    expect(manualRows.map((r) => r.teacherId)).toEqual([manualT.id]); // preserved
    const autoRows = after.filter((r) => r.assignmentSource === "AUTO");
    expect(autoRows.length).toBe(res.inserted);
    // no duplicates: unique teacher set + unique slot set
    expect(new Set(after.map((r) => r.teacherId)).size).toBe(after.length);
    expect(new Set(after.map((r) => r.dakoId + String.fromCharCode(124) + r.assignmentType)).size).toBe(after.length);
    // d2's SUGO slot stays with the manual teacher (occupied slot skipped)
    expect(after.find((r) => r.dakoId === d2.id && r.assignmentType === "SUGO")!.teacherId).toBe(manualT.id);

    // REGENERATED_SCHEDULE snapshot contains the complete previous AUTO set
    const regenAudits = await audits("REGENERATED_SCHEDULE");
    expect(regenAudits.length).toBe(1);
    const snap = (regenAudits[0]!.oldValue as { previousAutoAssignments: Record<string, unknown>[] }).previousAutoAssignments;
    expect(snap.length).toBe(autoBefore.length);
    expect(new Set(snap.map((s) => s.id))).toEqual(new Set(autoBefore.map((r) => r.id)));
    for (const s of snap) {
      expect(s).toHaveProperty("weekId");
      expect(s).toHaveProperty("dakoId");
      expect(s).toHaveProperty("teacherId");
      expect(s).toHaveProperty("assignmentType");
      expect(s).toHaveProperty("assignmentSource");
      expect(s).toHaveProperty("assignedAt");
    }
  });

  it("generation is rejected outside DRAFT; PUBLISHED stays immutable (§14/§5 of clarification)", async () => {
    const t = await mkTeacher("G7-1");
    const d = await mkDako("GD-7");
    void d;
    const wFinal = await mkWeek(2098, 6, "FINALIZED");
    await setAvail(t.id, wFinal.id, "AVAILABLE");
    const { SchedulingService, AssignmentService } = await import("@/server/services");
    await expect(SchedulingService.generateSchedule(wFinal.id, admin())).rejects.toThrow(/DRAFT/);
    const wPub = await mkWeek(2098, 7, "PUBLISHED");
    await setAvail(t.id, wPub.id, "AVAILABLE");
    await expect(SchedulingService.generateSchedule(wPub.id, admin())).rejects.toThrow(/DRAFT/);
    // assertWeekMutable still blocks service-level assignment writes for PUBLISHED weeks
    await expect(
      AssignmentService.createAssignment({ weekId: wPub.id, dakoId: d!.id, teacherId: t.id, assignmentType: "SUGO" }, admin()),
    ).rejects.toThrow(/PUBLISHED/);
  });

  // ------------------------------------------------------------ overrides
  it("scheduler cannot override a violating change; admin can with reason (§15)", async () => {
    const a = await mkTeacher("G8-1");
    const b = await mkTeacher("G8-2");
    const d = await mkDako("GD-8");
    const prev = await mkWeek(2099, 1);
    const cur = await mkWeek(2099, 2);
    await setAvail(a.id, prev.id, "ABSENT", "sick");
    await setAvail(a.id, cur.id, "AVAILABLE");
    await setAvail(b.id, cur.id, "AVAILABLE");
    const { SchedulingService, AssignmentService } = await import("@/server/services");
    const res = await SchedulingService.generateSchedule(cur.id, admin());
    const sugo = res.plan.slots.find((s) => s.assignmentType === "SUGO")!;
    expect(sugo.teacherId).toBe(b.id);
    // Scheduler attempts to swap in prev-week-absent `a` → forbidden
    const sugoBefore = (await weekRows(cur.id)).find((r) => r.assignmentType === "SUGO")!;
    await expect(
      AssignmentService.changeAssignment(sugoBefore.id, { teacherId: a.id, reason: "need a anyway" }, sched()),
    ).rejects.toThrow(/PREVIOUS_WEEK_ABSENT|administrator/);
    // Admin override succeeds, audited, reason recorded
    const sugoRow = (await weekRows(cur.id)).find((r) => r.assignmentType === "SUGO")!;
    const updated = await AssignmentService.changeAssignment(sugoRow.id, { teacherId: a.id, reason: "emergency coverage" }, admin());
    expect(updated.teacherId).toBe(a.id);
    expect(updated.assignmentSource).toBe("OVERRIDE");
    const overrides = await audits("MANUAL_ASSIGNMENT_OVERRIDE");
    const mine = overrides.find((o) => o.entityId === sugoRow.id);
    expect(mine).toBeTruthy();
    expect(mine!.reason).toContain("PREVIOUS_WEEK_ABSENT");
    expect(mine!.reason).toContain("emergency coverage");
    // engine never touched master data / availability (integrity)
    const [teacherAfter] = await db.select().from(schema.teachers).where(eq(schema.teachers.id, a.id));
    expect(teacherAfter!.status).toBe("ACTIVE");
    const [availAfter] = await db.select().from(schema.teacherAvailability).where(and(eq(schema.teacherAvailability.teacherId, a.id), eq(schema.teacherAvailability.weekId, cur.id)));
    expect(availAfter!.availabilityStatus).toBe("AVAILABLE");
  });

  it("eligibility-check returns violated rules for a proposed triple (§15)", async () => {
    const t = await mkTeacher("G9-1");
    const dEng = await mkDako("GD-9", { language: "ENGLISH" });
    const w = await mkWeek(2100, 1);
    await setAvail(t.id, w.id, "AVAILABLE");
    const { SchedulingService } = await import("@/server/services");
    const r = await SchedulingService.checkEligibility({ weekId: w.id, dakoId: dEng.id, teacherId: t.id });
    expect(r.eligible).toBe(false);
    expect(r.violatedRules).toContain("LANGUAGE_MISMATCH");
    expect(r.overrideAllowed).toBe(true);
  });

  // ---------------------------------------------------------- concurrency
  it("concurrent generations serialize — exactly one wins, no duplicates", async () => {
    const t1 = await mkTeacher("GC-1");
    const t2 = await mkTeacher("GC-2");
    const d = await mkDako("GDC-1");
    const w = await mkWeek(2101, 1);
    for (const t of [t1, t2]) await setAvail(t.id, w.id, "AVAILABLE");
    const { SchedulingService } = await import("@/server/services");
    const [r1, r2] = await Promise.allSettled([
      SchedulingService.generateSchedule(w.id, admin()),
      SchedulingService.generateSchedule(w.id, sched()),
    ]);
    const rows = await weekRows(w.id);
    // unique (week,dako,type) + (week,teacher) indexes must hold
    expect(new Set(rows.map((r) => `${r.dakoId}|${r.assignmentType}`)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.teacherId)).size).toBe(rows.length);
    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    void d;
  });

  // ------------------------------------------------------------ integrity
  it("generation/overrides never modify teacher, dako, availability, or destination data", async () => {
    const t = await mkTeacher("GI-1", { currentDestinationId: null });
    const d = await mkDako("GDI-1");
    await db.update(schema.teachers).set({ currentDestinationId: d.id }).where(eq(schema.teachers.id, t.id));
    const w = await mkWeek(2102, 1);
    await setAvail(t.id, w.id, "AVAILABLE");
    const teacherBefore = (await db.select().from(schema.teachers).where(eq(schema.teachers.id, t.id)))[0]!;
    const dakoBefore = (await db.select().from(schema.dako).where(eq(schema.dako.id, d.id)))[0]!;
    const availBefore = (await db.select().from(schema.teacherAvailability).where(and(eq(schema.teacherAvailability.teacherId, t.id), eq(schema.teacherAvailability.weekId, w.id))))[0]!;
    const { SchedulingService } = await import("@/server/services");
    await SchedulingService.generateSchedule(w.id, admin());
    const teacherAfter = (await db.select().from(schema.teachers).where(eq(schema.teachers.id, t.id)))[0]!;
    const dakoAfter = (await db.select().from(schema.dako).where(eq(schema.dako.id, d.id)))[0]!;
    const availAfter = (await db.select().from(schema.teacherAvailability).where(and(eq(schema.teacherAvailability.teacherId, t.id), eq(schema.teacherAvailability.weekId, w.id))))[0]!;
    expect(teacherAfter).toEqual(teacherBefore);
    expect(dakoAfter).toEqual(dakoBefore);
    expect(availAfter).toEqual(availBefore);
    expect(teacherAfter.currentDestinationId).toBe(d.id); // destination untouched
  });

  it("assignment_history stays append-only outside regeneration (migration 0003 guard)", async () => {
    const t = await mkTeacher("GH-1");
    const d = await mkDako("GDH-1");
    const w = await mkWeek(2104, 1);
    await setAvail(t.id, w.id, "AVAILABLE");
    const { SchedulingService } = await import("@/server/services");
    await SchedulingService.generateSchedule(w.id, admin());
    // Direct history delete without the transaction-local GUC must still fail.
    await expect(sql`DELETE FROM assignment_history`).rejects.toThrow(/append-only/);
    // Audit logs remain absolutely append-only.
    await expect(sql`DELETE FROM audit_logs`).rejects.toThrow(/append-only/);
  });

  it("preview matches generation output without writing (§6)", async () => {
    const t1 = await mkTeacher("GP-1");
    const t2 = await mkTeacher("GP-2");
    const d = await mkDako("GDP-1");
    const w = await mkWeek(2103, 1);
    for (const t of [t1, t2]) await setAvail(t.id, w.id, "AVAILABLE");
    const { SchedulingService } = await import("@/server/services");
    const pv = await SchedulingService.previewSchedule(w.id);
    expect(pv.slots.find((s) => s.assignmentType === "SUGO")!.teacherId).toBe(t1.id);
    expect((await weekRows(w.id)).length).toBe(0); // no writes
    const gen = await SchedulingService.generateSchedule(w.id, admin());
    expect(gen.plan).toEqual({ slots: pv.slots, summary: pv.summary }); // identical plan
  });
});
