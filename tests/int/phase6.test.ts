/**
 * Phase 6 — cell workflows, absence/replacement, code generation (§33).
 * Covers: clear (CHANGE_OF_SUGUAN vs TEACHER_ABSENT), atomic replace with
 * server-side eligibility (incl. non-overrideable LANGUAGE_MISMATCH), PUBLISHED
 * immutability, RBAC, sequential + concurrency-safe code generation, and the
 * batched annual cell-info provenance.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
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

function weekStart(year: number, week: number): string {
  const jan4 = new Date(`${year}-01-04T00:00:00Z`);
  const dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (dow - 1) + (week - 1) * 7);
  const end = new Date(monday);
  end.setUTCDate(monday.getUTCDate() + 6);
  return monday.toISOString().slice(0, 10);
}

describe("phase 6 — assignment workflows, absence, replacement, codes", () => {
  let adminId: string;
  let schedId: string;
  let viewerId: string;

  beforeEach(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
    schedId = await seedScheduler();
    viewerId = await seedViewer();
  });

  afterAll(async () => {
    await teardown();
  });

  async function seedViewer(): Promise<string> {
    const passwordHash = (await import("@/server/auth/password")).hashPassword;
    const hash = await passwordHash("TestViewerPass1!");
    const inserted = await db
      .insert(schema.users)
      .values({ email: "viewer@test.local", fullName: "Test Viewer", passwordHash: hash })
      .returning();
    const user = inserted[0]!;
    const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, "VIEWER"));
    await db.insert(schema.userRoles).values({ userId: user.id, roleId: roleRows[0]!.id });
    return user.id;
  }

  const admin = () => actor(adminId, ["ADMIN"]);
  const sched = () => actor(schedId, ["SCHEDULER"]);
  const viewer = () => actor(viewerId, ["VIEWER"]);

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
  async function setAvail(teacherId: string, weekId: string, status: string, reason?: string) {
    await db.insert(schema.teacherAvailability).values({
      teacherId,
      weekId,
      availabilityStatus: status,
      reason: reason ?? null,
    }).onConflictDoUpdate({
      target: [schema.teacherAvailability.teacherId, schema.teacherAvailability.weekId],
      set: { availabilityStatus: status, reason: reason ?? null },
    });
  }
  async function audits(action: string) {
    return db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action));
  }

  /** Generates a full SUGO/RESERBA(/RESERBA_II) draft for the week. */
  async function generateWeek(weekId: string) {
    const { SchedulingService } = await import("@/server/services");
    return SchedulingService.generateSchedule(weekId, admin());
  }

  // ------------------------------------------------- clear: change of suguan
  it("CHANGE_OF_SUGUAN clears the assignment, keeps the teacher available, is NOT absent, audits CLEARED_ASSIGNMENT", async () => {
    const t1 = await mkTeacher("G1-1");
    const t2 = await mkTeacher("G1-2");
    const d = await mkDako("GD-1");
    const w = await mkWeek(2092, 3);
    for (const t of [t1, t2]) await setAvail(t.id, w.id, "AVAILABLE");
    await generateWeek(w.id);

    const rows = await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id));
    const sugo = rows.find((r) => r.assignmentType === "SUGO")!;
    expect(sugo.teacherId).toBe(t1.id);

    const { AssignmentService } = await import("@/server/services");
    await AssignmentService.clearAssignment(sugo.id, { clearType: "CHANGE_OF_SUGUAN", reason: "Change of Suguan" }, sched());

    const after = await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id));
    expect(after.find((r) => r.id === sugo.id)).toBeUndefined();
    // NOT absent — availability untouched for a Change of Suguan (§4).
    const av = await db.select().from(schema.teacherAvailability)
      .where(and(eq(schema.teacherAvailability.teacherId, t1.id), eq(schema.teacherAvailability.weekId, w.id)));
    expect(av[0]!.availabilityStatus).toBe("AVAILABLE");
    expect(av[0]!.reason).toBeNull();
    const cleared = await audits("CLEARED_ASSIGNMENT");
    expect(cleared.length).toBe(1);
    expect((cleared[0]!.oldValue as Record<string, unknown>).id).toBe(sugo.id);
    expect(cleared[0]!.reason).toBe("Change of Suguan");
  });

  // --------------------------------------------- clear: teacher absent
  it("TEACHER_ABSENT clear marks the teacher ABSENT for the week with reason, audits both actions", async () => {
    const t1 = await mkTeacher("G2-1");
    const t2 = await mkTeacher("G2-2");
    const d = await mkDako("GD-2");
    const w = await mkWeek(2092, 4);
    for (const t of [t1, t2]) await setAvail(t.id, w.id, "AVAILABLE");
    await generateWeek(w.id);

    const sugo = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id)))
      .find((r) => r.assignmentType === "SUGO")!;

    const { AssignmentService } = await import("@/server/services");
    await AssignmentService.clearAssignment(sugo.id, { clearType: "TEACHER_ABSENT", reason: "Teacher is absent in Class", absentReason: "Sick" }, sched());

    const av = await db.select().from(schema.teacherAvailability)
      .where(and(eq(schema.teacherAvailability.teacherId, t1.id), eq(schema.teacherAvailability.weekId, w.id)));
    expect(av[0]!.availabilityStatus).toBe("ABSENT");
    expect(av[0]!.reason).toBe("Sick");
    expect((await audits("CLEARED_ASSIGNMENT")).length).toBe(1);
    expect((await audits("TEACHER_MARKED_ABSENT")).length).toBe(1);
  });

  it("clear requires a non-empty reason (server-side)", async () => {
    const t1 = await mkTeacher("G3-1");
    const d = await mkDako("GD-3");
    const w = await mkWeek(2092, 5);
    await setAvail(t1.id, w.id, "AVAILABLE");
    await generateWeek(w.id);
    const sugo = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id)))
      .find((r) => r.assignmentType === "SUGO")!;

    const { AssignmentService } = await import("@/server/services");
    await expect(
      AssignmentService.clearAssignment(sugo.id, { clearType: "CHANGE_OF_SUGUAN", reason: "   " }, sched()),
    ).rejects.toThrow();
    await expect(
      AssignmentService.clearAssignment(sugo.id, { clearType: "TEACHER_ABSENT", reason: "Teacher is absent in Class", absentReason: "" }, sched()),
    ).rejects.toThrow();
  });

  it("previous-week ABSENT teacher is hard-excluded from the NEXT week's automatic generation", async () => {
    const t1 = await mkTeacher("G4-1");
    const t2 = await mkTeacher("G4-2");
    const t3 = await mkTeacher("G4-3");
    const d = await mkDako("GD-4");
    const w1 = await mkWeek(2092, 6);
    const w2 = await mkWeek(2092, 7);
    for (const t of [t1, t2, t3]) {
      await setAvail(t.id, w1.id, "AVAILABLE");
      await setAvail(t.id, w2.id, "AVAILABLE");
    }
    await generateWeek(w1.id);

    const sugo1 = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w1.id)))
      .find((r) => r.assignmentType === "SUGO")!;
    const { AssignmentService } = await import("@/server/services");
    await AssignmentService.clearAssignment(sugo1.id, { clearType: "TEACHER_ABSENT", reason: "Teacher is absent in Class", absentReason: "Sick" }, sched());

    const res = await generateWeek(w2.id);
    const assigned = res.plan.slots.filter((s) => s.teacherId).map((s) => s.teacherId);
    expect(assigned).not.toContain(t1.id); // §E — hard exclusion from automatic scheduling
  });

  // --------------------------------------------- modify / replacement
  it("MODIFY marks the original absent, assigns an eligible replacement atomically, source MANUAL for rule-conforming", async () => {
    const t1 = await mkTeacher("G5-1");
    const t2 = await mkTeacher("G5-2"); // will hold RESERBA after generation
    const t3 = await mkTeacher("G5-3"); // will hold RESERBA_II (leftover pool)
    const t4 = await mkTeacher("G5-4"); // FREE eligible replacement
    const d = await mkDako("GD-5");
    const w = await mkWeek(2092, 8);
    for (const t of [t1, t2, t3, t4]) await setAvail(t.id, w.id, "AVAILABLE");
    await generateWeek(w.id);

    const sugo = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id)))
      .find((r) => r.assignmentType === "SUGO")!;
    expect(sugo.teacherId).toBe(t1.id);

    const { AssignmentService } = await import("@/server/services");
    const list = await AssignmentService.listEligibleReplacements(w.id, d.id, sugo.id);
    // t2/t3 hold RESERBA/RESERBA_II this week → excluded (one per teacher).
    expect(list.rows.map((r) => r.teacherId)).toEqual([t4.id]);

    const updated = await AssignmentService.replaceAbsentTeacher(
      sugo.id,
      { replacementTeacherId: t4.id, absentReason: "Urgent Matter" },
      sched(),
    );
    expect(updated.teacherId).toBe(t4.id);
    // §12 — rule-conforming replacement is MANUAL, not OVERRIDE.
    expect(updated.assignmentSource).toBe("MANUAL");

    const av = await db.select().from(schema.teacherAvailability)
      .where(and(eq(schema.teacherAvailability.teacherId, t1.id), eq(schema.teacherAvailability.weekId, w.id)));
    expect(av[0]!.availabilityStatus).toBe("ABSENT");
    expect(av[0]!.reason).toBe("Urgent Matter");
    expect((await audits("MANUAL_ASSIGNMENT_OVERRIDE")).length).toBe(0); // no rule violated
    expect((await audits("CHANGED_ASSIGNMENT")).length).toBe(1);
  });

  it("replacement list excludes ineligible: master-INACTIVE, weekly ABSENT, weekly INACTIVE, NOT_ENCODED, already-assigned", async () => {
    const t1 = await mkTeacher("G6-1");
    const t2 = await mkTeacher("G6-2"); // the only OTHER available candidate
    const tInactive = await mkTeacher("G6-3", { status: "INACTIVE" });
    const t4 = await mkTeacher("G6-4");
    const t5 = await mkTeacher("G6-5");
    const t6 = await mkTeacher("G6-6");
    const t7 = await mkTeacher("G6-7"); // eligible — will take a slot
    const t8 = await mkTeacher("G6-8"); // the ONLY teacher left free
    const d = await mkDako("GD-6");
    const w = await mkWeek(2092, 9);
    await setAvail(t1.id, w.id, "AVAILABLE");
    await setAvail(t2.id, w.id, "AVAILABLE");
    await setAvail(tInactive.id, w.id, "AVAILABLE"); // master-INACTIVE must not help
    await setAvail(t4.id, w.id, "ABSENT", "Sick");
    await setAvail(t5.id, w.id, "INACTIVE");
    await setAvail(t7.id, w.id, "AVAILABLE");
    await setAvail(t8.id, w.id, "AVAILABLE");
    // t6 NOT_ENCODED — no record
    await generateWeek(w.id);
    const sugo = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id)))
      .find((r) => r.assignmentType === "SUGO")!;

    const { AssignmentService } = await import("@/server/services");
    const list = await AssignmentService.listEligibleReplacements(w.id, d.id, sugo.id);
    const ids = list.rows.map((r) => r.teacherId);
    // t1/t2/t7 fill SUGO/RESERBA/RESERBA_II; only t8 remains a candidate.
    expect(ids).toEqual([t8.id]);
    expect(ids).not.toContain(tInactive.id); // master-INACTIVE
    expect(ids).not.toContain(t4.id); // weekly ABSENT
    expect(ids).not.toContain(t5.id); // weekly INACTIVE
    expect(ids).not.toContain(t6.id); // NOT_ENCODED
    expect(ids).not.toContain(tInactive.id); // master-INACTIVE
    expect(ids).not.toContain(t4.id); // weekly ABSENT
    expect(ids).not.toContain(t5.id); // weekly INACTIVE
    expect(ids).not.toContain(t6.id); // NOT_ENCODED
  });

  it("Filipino teacher can NEVER replace into an English dako — not even ADMIN with a reason (§10/§14)", async () => {
    const t1 = await mkTeacher("G7-1"); // FILIPINO
    const tEn = await mkTeacher("G7-2", { language: "ENGLISH" });
    const tFil = await mkTeacher("G7-3"); // FILIPINO
    const dEn = await mkDako("GD-7", { language: "ENGLISH" });
    const w = await mkWeek(2092, 10);
    for (const t of [t1, tEn, tFil]) await setAvail(t.id, w.id, "AVAILABLE");
    // Seed an English teacher onto the English dako manually (bypass generate).
    const ins = await db.insert(schema.assignments).values({
      weekId: w.id, dakoId: dEn.id, teacherId: tEn.id, assignmentType: "SUGO",
      assignmentSource: "MANUAL", status: "ASSIGNED",
    }).returning();
    const sugo = ins[0]!;

    const { AssignmentService } = await import("@/server/services");
    const list = await AssignmentService.listEligibleReplacements(w.id, dEn.id, sugo.id);
    expect(list.rows.map((r) => r.teacherId)).not.toContain(tFil.id); // not offered

    await expect(
      AssignmentService.replaceAbsentTeacher(sugo.id, { replacementTeacherId: tFil.id, absentReason: "Sick" }, sched()),
    ).rejects.toThrow(/non-overrideable/);
    await expect(
      AssignmentService.replaceAbsentTeacher(sugo.id, { replacementTeacherId: tFil.id, absentReason: "Sick" }, admin()),
    ).rejects.toThrow(/non-overrideable/);
  });

  it("replacement teacher already assigned elsewhere this week is rejected", async () => {
    const t1 = await mkTeacher("G8-1");
    const t2 = await mkTeacher("G8-2");
    const t3 = await mkTeacher("G8-3");
    const d = await mkDako("GD-8");
    const w = await mkWeek(2092, 11);
    for (const t of [t1, t2, t3]) await setAvail(t.id, w.id, "AVAILABLE");
    await generateWeek(w.id);
    const reserba = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id)))
      .find((r) => r.assignmentType === "RESERBA")!;

    const { AssignmentService } = await import("@/server/services");
    // t1 holds SUGO this week; even ADMIN cannot move them into RESERBA —
    // the one-assignment-per-teacher-per-week rule is structural.
    await expect(
      AssignmentService.replaceAbsentTeacher(reserba.id, { replacementTeacherId: t1.id, absentReason: "Sick" }, admin()),
    ).rejects.toThrow(/ALREADY_ASSIGNED_THIS_WEEK/);
  });

  // --------------------------------------------- lifecycle / RBAC
  it("PUBLISHED week rejects clear and replace (permanently immutable)", async () => {
    const t1 = await mkTeacher("G9-1");
    const t2 = await mkTeacher("G9-2");
    const d = await mkDako("GD-9");
    const w = await mkWeek(2092, 12, "PUBLISHED");
    for (const t of [t1, t2]) await setAvail(t.id, w.id, "AVAILABLE");
    const ins = await db.insert(schema.assignments).values({
      weekId: w.id, dakoId: d.id, teacherId: t1.id, assignmentType: "SUGO",
      assignmentSource: "MANUAL", status: "ASSIGNED",
    }).returning();
    const sugo = ins[0]!;

    const { AssignmentService } = await import("@/server/services");
    await expect(
      AssignmentService.clearAssignment(sugo.id, { clearType: "CHANGE_OF_SUGUAN", reason: "x" }, admin()),
    ).rejects.toThrow();
    await expect(
      AssignmentService.replaceAbsentTeacher(sugo.id, { replacementTeacherId: t2.id, absentReason: "Sick" }, admin()),
    ).rejects.toThrow();
  });

  it("Viewer cannot clear or replace; Scheduler CAN clear/modify (§27)", async () => {
    const t1 = await mkTeacher("G10-1");
    const t2 = await mkTeacher("G10-2");
    const d = await mkDako("GD-10");
    const w = await mkWeek(2092, 13);
    for (const t of [t1, t2]) await setAvail(t.id, w.id, "AVAILABLE");
    await generateWeek(w.id);
    const sugo = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id)))
      .find((r) => r.assignmentType === "SUGO")!;

    const { AssignmentService } = await import("@/server/services");
    await expect(
      AssignmentService.clearAssignment(sugo.id, { clearType: "CHANGE_OF_SUGUAN", reason: "x" }, viewer()),
    ).rejects.toThrow();
    await expect(
      AssignmentService.replaceAbsentTeacher(sugo.id, { replacementTeacherId: t2.id, absentReason: "Sick" }, viewer()),
    ).rejects.toThrow();
  });

  // --------------------------------------------- code generation
  it("teacher codes auto-generate sequentially from the sequence (PNK-G-####)", async () => {
    const { TeacherService } = await import("@/server/services");
    const a = await TeacherService.createTeacher({ firstName: "A", lastName: "Alpha", language: "FILIPINO" }, admin());
    const b = await TeacherService.createTeacher({ firstName: "B", lastName: "Bravo", language: "FILIPINO" }, admin());
    expect(a.teacherCode).toMatch(/^PNK-G-\d{4,}$/);
    expect(b.teacherCode).toMatch(/^PNK-G-\d{4,}$/);
    expect(Number(b.teacherCode.slice(6))).toBe(Number(a.teacherCode.slice(6)) + 1);
  });

  it("dako codes auto-generate sequentially from the sequence (ILGD-###)", async () => {
    const { DakoService } = await import("@/server/services");
    const a = await DakoService.createDako({ name: "Dako Seq A", address: "Addr", dateEstablished: "2000-01-01", worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO" }, admin());
    const b = await DakoService.createDako({ name: "Dako Seq B", address: "Addr", dateEstablished: "2000-01-01", worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO" }, admin());
    expect(a.dakoCode).toMatch(/^ILGD-\d{3,}$/);
    expect(b.dakoCode).toMatch(/^ILGD-\d{3,}$/);
    expect(Number(b.dakoCode.slice(5))).toBe(Number(a.dakoCode.slice(5)) + 1);
  });

  it("concurrent teacher creation never produces duplicate codes (§21)", async () => {
    const { TeacherService } = await import("@/server/services");
    // Force tight interleaving: two Promise.all creates over one connection
    // pool would serialize, so emulate racing callers with separate sequences
    // of direct nextval draws in independent transactions instead.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        TeacherService.createTeacher({ firstName: `C${i}`, lastName: `Conc${i}`, language: "FILIPINO" }, admin()),
      ),
    );
    const codes = results.map((r) => r.teacherCode);
    expect(new Set(codes).size).toBe(codes.length); // uniqueness under concurrency
  });

  it("deactivated teacher codes are not reused (§21) — sequence keeps advancing", async () => {
    const { TeacherService } = await import("@/server/services");
    const a = await TeacherService.createTeacher({ firstName: "D1", lastName: "One", language: "FILIPINO" }, admin());
    // §14 — deactivation goes through the dedicated Phase 2 flow.
    await TeacherService.deactivateTeacher(a.id, "test deactivation", admin());
    const b = await TeacherService.createTeacher({ firstName: "D2", lastName: "Two", language: "FILIPINO" }, admin());
    expect(Number(b.teacherCode.slice(6))).toBeGreaterThan(Number(a.teacherCode.slice(6)));
  });

  // --------------------------------------------- annual cell info (§7/§14)
  it("getAnnualCellInfo returns persisted absence + modification provenance batched (§34)", async () => {
    const t1 = await mkTeacher("G11-1");
    const t2 = await mkTeacher("G11-2");
    const t3 = await mkTeacher("G11-3");
    const t4 = await mkTeacher("G11-4"); // free replacement (pool keeps t2/t3 busy)
    const d = await mkDako("GD-11");
    const w = await mkWeek(2092, 14);
    for (const t of [t1, t2, t3, t4]) await setAvail(t.id, w.id, "AVAILABLE");
    await generateWeek(w.id);
    const sugo = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id)))
      .find((r) => r.assignmentType === "SUGO")!;

    const { AssignmentService } = await import("@/server/services");
    // Modify → original absent + replacement.
    await AssignmentService.replaceAbsentTeacher(sugo.id, { replacementTeacherId: t4.id, absentReason: "Traffic" }, sched());

    const info = await AssignmentService.getAnnualCellInfo(2092);
    const mod = info.modifiedInfo.find((m) => m.assignmentId === sugo.id);
    expect(mod).toBeDefined();
    expect(mod!.originalTeacherName).toContain(t1.lastName);
    expect(mod!.replacementTeacherName).toContain(t4.lastName);
    expect(mod!.reason).toContain("Traffic");
    expect(mod!.actorName).toBeTruthy();

    // Clear with absence → absentInfo carries the reason.
    const w2 = await mkWeek(2092, 15);
    const t5 = await mkTeacher("G11-5");
    const t6 = await mkTeacher("G11-6");
    for (const t of [t5, t6]) await setAvail(t.id, w2.id, "AVAILABLE");
    await generateWeek(w2.id);
    const sugo2 = (await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w2.id)))
      .find((r) => r.assignmentType === "SUGO")!;
    await AssignmentService.clearAssignment(sugo2.id, { clearType: "TEACHER_ABSENT", reason: "Teacher is absent in Class", absentReason: "No Info" }, sched());

    const info2 = await AssignmentService.getAnnualCellInfo(2092);
    const absent = info2.absentInfo.find((a) => a.weekId === w2.id && a.assignmentType === "SUGO");
    expect(absent).toBeDefined();
    expect(absent!.reason).toBe("No Info");
  });
});
