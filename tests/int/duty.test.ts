/**
 * Guro Duty (Destinado / Katuwang) Update — integration tests (#18):
 * duty CRUD persistence & validation, both generation modes end-to-end,
 * per-dako fair rotation across regenerations, hard-rule supremacy,
 * DRAFT lifecycle, MANUAL survival, audit trail, and Auto-generate
 * regression. Real services against the real test database.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import { TeacherService, DakoService, SchedulingService } from "@/server/services";
import type { SessionUser } from "@/server/auth/session";

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

function teacherInput(code: string, over: Partial<Parameters<typeof TeacherService.createTeacher>[0]> = {}) {
  return { teacherCode: code, firstName: "First", lastName: code, language: "FILIPINO" as const, ...over };
}

function dakoInput(code: string, over: Partial<Parameters<typeof DakoService.createDako>[0]> = {}) {
  return {
    dakoCode: code,
    name: `Dako ${code}`,
    address: "1 Test St",
    dateEstablished: "2001-06-15",
    worshipDay: "SUNDAY" as const,
    worshipTime: "09:00",
    language: "FILIPINO" as const,
    ...over,
  };
}

/** Monday of ISO week 1 for the given year (approximation is fine for week rows). */
function weekStart(year: number, week: number): string {
  const jan4 = new Date(`${year}-01-04T00:00:00Z`);
  const dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (dow - 1) + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

async function mkWeek(year: number, week: number, status = "DRAFT") {
  const start = weekStart(year, week);
  const endD = new Date(`${start}T00:00:00Z`);
  endD.setUTCDate(endD.getUTCDate() + 6);
  const rows = await db
    .insert(schema.weeks)
    .values({
      year,
      isoWeekNumber: week,
      startDate: start,
      endDate: endD.toISOString().slice(0, 10),
      status,
    })
    .returning();
  return rows[0]!;
}

async function setAvail(teacherId: string, weekId: string, status: string) {
  await db
    .insert(schema.teacherAvailability)
    .values({ teacherId, weekId, availabilityStatus: status, reason: null })
    .onConflictDoUpdate({
      target: [schema.teacherAvailability.teacherId, schema.teacherAvailability.weekId],
      set: { availabilityStatus: status },
    });
}

async function weekRows(weekId: string) {
  return db.select().from(schema.assignments).where(eq(schema.assignments.weekId, weekId));
}

describe("Guro Duty — Assign Destinado / Assign Katuwang", () => {
  let admin: SessionUser;

  beforeEach(async () => {
    await resetTestDb();
    admin = actor(await seedAdmin(), ["ADMIN"]);
  });

  afterAll(async () => {
    await teardown();
  });

  it("duty is persistent teacher data — created, edited, validated, never inferred", async () => {
    const t1 = await TeacherService.createTeacher({ ...teacherInput("DT-01"), duty: "DESTINADO" }, admin);
    expect(t1.duty).toBe("DESTINADO");
    const t2 = await TeacherService.createTeacher({ ...teacherInput("DT-02"), duty: "KATUWANG" }, admin);
    expect(t2.duty).toBe("KATUWANG");
    // Missing duty stays null (legacy-safe) — never invented.
    const t3 = await TeacherService.createTeacher(teacherInput("DT-03"), admin);
    expect(t3.duty).toBeNull();
    // Invalid duty is rejected.
    await expect(
      TeacherService.createTeacher({ ...teacherInput("DT-04"), duty: "BOSS" as "DESTINADO" }, admin),
    ).rejects.toThrow();
    await expect(TeacherService.updateTeacher(t3.id, { duty: "HEAD" }, admin)).rejects.toThrow();

    // Editing duty persists and does not rewrite historical assignments.
    const d = await DakoService.createDako(dakoInput("DT-0"), admin);
    const w = await mkWeek(2090, 2);
    await db.insert(schema.assignments).values({
      weekId: w.id,
      dakoId: d.id,
      teacherId: t3.id,
      assignmentType: "SUGO",
      assignmentSource: "MANUAL",
      status: "ASSIGNED",
      isOverride: false,
    });
    const historyBefore = await weekRows(w.id);
    const updated = await TeacherService.updateTeacher(t3.id, { duty: "KATUWANG" }, admin);
    expect(updated.duty).toBe("KATUWANG");
    expect(await weekRows(w.id)).toEqual(historyBefore);
  });

  it("ASSIGN_DESTINADO: Destinado → SUGO, Katuwang → RESERBA/RESERBA_II; correct dako; DRAFT; audited", async () => {
    const dako = await DakoService.createDako(dakoInput("DT-1"), admin);
    const dest = await TeacherService.createTeacher(
      { ...teacherInput("DT-A"), duty: "DESTINADO", currentDestinationId: dako.id },
      admin,
    );
    const katB = await TeacherService.createTeacher(
      { ...teacherInput("DT-B"), duty: "KATUWANG", currentDestinationId: dako.id },
      admin,
    );
    const katC = await TeacherService.createTeacher(
      { ...teacherInput("DT-C"), duty: "KATUWANG", currentDestinationId: dako.id },
      admin,
    );
    const w = await mkWeek(2091, 2);
    for (const t of [dest, katB, katC]) await setAvail(t.id, w.id, "AVAILABLE");

    const res = await SchedulingService.generateDutySchedule(w.id, "ASSIGN_DESTINADO", admin);
    expect(res.mode).toBe("ASSIGN_DESTINADO");
    expect(res.inserted).toBe(3);
    expect(res.plan.slots.find((s) => s.assignmentType === "SUGO")!.duty).toBe("DESTINADO");

    const rows = await weekRows(w.id);
    expect(rows.length).toBe(3);
    const byType = Object.fromEntries(rows.map((r) => [r.assignmentType, r]));
    expect(byType.SUGO!.teacherId).toBe(dest.id);
    expect(byType.RESERBA!.teacherId).toBe(katB.id);
    expect(byType.RESERBA_II!.teacherId).toBe(katC.id);
    for (const r of rows) {
      expect(r.dakoId).toBe(dako.id); // never cross-dako
      expect(r.generationMode).toBe("ASSIGN_DESTINADO");
      expect(r.assignmentSource).toBe("AUTO");
      expect(r.status).toBe("ASSIGNED");
    }
    // Lifecycle (#13): the week remains DRAFT — never finalized/published.
    const [weekRow] = await db.select().from(schema.weeks).where(eq(schema.weeks.id, w.id));
    expect(weekRow!.status).toBe("DRAFT");

    // Audit (#17): mode, plan trail with duty, actor, role.
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "GENERATED_DUTY_SCHEDULE"));
    expect(logs.length).toBe(1);
    const nv = logs[0]!.newValue as {
      generationMode: string;
      role: string[];
      plan: { assignmentType: string; duty: string | null; rotation: unknown }[];
    };
    expect(nv.generationMode).toBe("ASSIGN_DESTINADO");
    expect(nv.role).toContain("ADMIN");
    expect(nv.plan.find((s) => s.assignmentType === "SUGO")!.duty).toBe("DESTINADO");
    expect(nv.plan.find((s) => s.assignmentType === "RESERBA")!.duty).toBe("KATUWANG");
  });

  it("ASSIGN_KATUWANG: Katuwang → SUGO, Destinado → RESERBA; fair rotation on next use (spec example)", async () => {
    const dako = await DakoService.createDako(dakoInput("DT-2"), admin);
    const dest = await TeacherService.createTeacher(
      { ...teacherInput("DT-D1"), duty: "DESTINADO", currentDestinationId: dako.id },
      admin,
    );
    const kat2 = await TeacherService.createTeacher(
      { ...teacherInput("DT-K2"), duty: "KATUWANG", currentDestinationId: dako.id },
      admin,
    );
    const kat3 = await TeacherService.createTeacher(
      { ...teacherInput("DT-K3"), duty: "KATUWANG", currentDestinationId: dako.id },
      admin,
    );
    const w = await mkWeek(2092, 3);
    for (const t of [dest, kat2, kat3]) await setAvail(t.id, w.id, "AVAILABLE");

    // Use 1: K2 → SUGO (stable code tie-break), Dest → RESERBA, K3 → RESERBA_II.
    const r1 = await SchedulingService.generateDutySchedule(w.id, "ASSIGN_KATUWANG", admin);
    const t1 = Object.fromEntries(r1.plan.slots.map((s) => [s.assignmentType, s.teacherId]));
    expect(t1.SUGO).toBe(kat2.id);
    expect(t1.RESERBA).toBe(dest.id);
    expect(t1.RESERBA_II).toBe(kat3.id);

    // Use 2 (regenerate): the fair rotation swaps the Katuwang — K3 → SUGO,
    // Dest stays RESERBA, K2 → RESERBA_II. Never the same first Katuwang.
    const r2 = await SchedulingService.generateDutySchedule(w.id, "ASSIGN_KATUWANG", admin);
    expect(r2.regenerated).toBe(true);
    const t2 = Object.fromEntries(r2.plan.slots.map((s) => [s.assignmentType, s.teacherId]));
    expect(t2.SUGO).toBe(kat3.id);
    expect(t2.RESERBA).toBe(dest.id);
    expect(t2.RESERBA_II).toBe(kat2.id);

    // The DB reflects exactly the second plan, still AUTO + this mode.
    const rows = await weekRows(w.id);
    expect(rows.length).toBe(3);
    expect(rows.filter((r) => r.assignmentType === "SUGO")[0]!.teacherId).toBe(kat3.id);

    // Audit trail: regeneration captured the full previous set and the new plan.
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "GENERATED_DUTY_SCHEDULE"));
    expect(logs.length).toBe(2);
    const regen = logs
      .map((l) => l.oldValue as { previousAutoAssignments: { teacherId: string }[] } | null)
      .find((v) => v?.previousAutoAssignments);
    expect(regen!.previousAutoAssignments.length).toBe(3);
  });

  it("duty NEVER bypasses hard eligibility (oath date, language) — no duty-deserving promotion", async () => {
    // Oath date not reached: the Destinado cannot serve — and a Katuwang must
    // NOT be promoted into the SUGO slot in ASSIGN_DESTINADO mode.
    const d1 = await DakoService.createDako(dakoInput("DT-3"), admin);
    const oathBlocked = await TeacherService.createTeacher(
      {
        ...teacherInput("DT-O1"),
        duty: "DESTINADO",
        currentDestinationId: d1.id,
        dateOfOath: "2099-01-01",
      },
      admin,
    );
    const kat = await TeacherService.createTeacher(
      { ...teacherInput("DT-O2"), duty: "KATUWANG", currentDestinationId: d1.id },
      admin,
    );
    const w1 = await mkWeek(2093, 2);
    await setAvail(oathBlocked.id, w1.id, "AVAILABLE");
    await setAvail(kat.id, w1.id, "AVAILABLE");
    const res = await SchedulingService.generateDutySchedule(w1.id, "ASSIGN_DESTINADO", admin);
    const sugo = res.plan.slots.find((s) => s.assignmentType === "SUGO")!;
    expect(sugo.teacherId).toBeNull();
    expect(sugo.reasonCode).toBe("NO_ELIGIBLE_CANDIDATES");
    expect(sugo.reason).toContain("OATH_DATE_NOT_REACHED");
    const rows1 = await weekRows(w1.id);
    expect(rows1.find((r) => r.assignmentType === "SUGO")).toBeUndefined();
    expect(rows1.find((r) => r.assignmentType === "RESERBA")!.teacherId).toBe(kat.id);

    // Language rule: a Filipino-only roster cannot serve an English dako.
    const d2 = await DakoService.createDako(dakoInput("DT-4", { language: "ENGLISH" }), admin);
    const fil = await TeacherService.createTeacher(
      { ...teacherInput("DT-O3"), duty: "KATUWANG", currentDestinationId: d2.id },
      admin,
    );
    const w2 = await mkWeek(2093, 3);
    await setAvail(fil.id, w2.id, "AVAILABLE");
    const res2 = await SchedulingService.generateDutySchedule(w2.id, "ASSIGN_KATUWANG", admin);
    // The English dako's own SUGO slot (d1's slot is a different, valid plan row).
    const sugo2 = res2.plan.slots.find((s) => s.assignmentType === "SUGO" && s.dakoId === d2.id)!;
    expect(sugo2.teacherId).toBeNull();
    expect(sugo2.reason).toContain("LANGUAGE_MISMATCH");
    expect((await weekRows(w2.id)).length).toBe(0);
  });

  it("duty generation refuses non-DRAFT weeks and keeps the week DRAFT (#13)", async () => {
    const dako = await DakoService.createDako(dakoInput("DT-5"), admin);
    const t = await TeacherService.createTeacher(
      { ...teacherInput("DT-F1"), duty: "DESTINADO", currentDestinationId: dako.id },
      admin,
    );
    const wF = await mkWeek(2094, 4, "FINALIZED");
    await setAvail(t.id, wF.id, "AVAILABLE");
    await expect(SchedulingService.generateDutySchedule(wF.id, "ASSIGN_DESTINADO", admin)).rejects.toThrow(/DRAFT/);
    const wP = await mkWeek(2094, 5, "PUBLISHED");
    await setAvail(t.id, wP.id, "AVAILABLE");
    await expect(SchedulingService.generateDutySchedule(wP.id, "ASSIGN_KATUWANG", admin)).rejects.toThrow(/DRAFT/);
  });

  it("MANUAL rows survive duty generation and their slots/teachers are immovable (#14)", async () => {
    const dako = await DakoService.createDako(dakoInput("DT-6"), admin);
    const dest = await TeacherService.createTeacher(
      { ...teacherInput("DT-M1"), duty: "DESTINADO", currentDestinationId: dako.id },
      admin,
    );
    const kat2 = await TeacherService.createTeacher(
      { ...teacherInput("DT-M2"), duty: "KATUWANG", currentDestinationId: dako.id },
      admin,
    );
    const kat3 = await TeacherService.createTeacher(
      { ...teacherInput("DT-M3"), duty: "KATUWANG", currentDestinationId: dako.id },
      admin,
    );
    const w = await mkWeek(2095, 2);
    for (const t of [dest, kat2, kat3]) await setAvail(t.id, w.id, "AVAILABLE");
    // A MANUAL SUGO already holds the slot for kat3.
    await db.insert(schema.assignments).values({
      weekId: w.id,
      dakoId: dako.id,
      teacherId: kat3.id,
      assignmentType: "SUGO",
      assignmentSource: "MANUAL",
      status: "ASSIGNED",
      isOverride: false,
    });

    const res = await SchedulingService.generateDutySchedule(w.id, "ASSIGN_KATUWANG", admin);
    // The occupied SUGO slot is never planned again…
    expect(res.plan.slots.find((s) => s.assignmentType === "SUGO")).toBeUndefined();
    // …its teacher is never double-assigned, and free slots fill normally.
    const rows = await weekRows(w.id);
    expect(rows.length).toBe(3);
    const sugoRow = rows.find((r) => r.assignmentType === "SUGO")!;
    expect(sugoRow.teacherId).toBe(kat3.id);
    expect(sugoRow.assignmentSource).toBe("MANUAL");
    expect(rows.find((r) => r.assignmentType === "RESERBA")!.teacherId).toBe(dest.id);
    expect(rows.find((r) => r.assignmentType === "RESERBA_II")!.teacherId).toBe(kat2.id);
  });

  it("regression: Auto-generate is unaffected by duty (duty teachers remain eligible)", async () => {
    const dako = await DakoService.createDako(dakoInput("DT-7"), admin);
    const dest = await TeacherService.createTeacher(
      { ...teacherInput("DT-R1"), duty: "DESTINADO", currentDestinationId: dako.id },
      admin,
    );
    const kat = await TeacherService.createTeacher(
      { ...teacherInput("DT-R2"), duty: "KATUWANG", currentDestinationId: dako.id },
      admin,
    );
    const plain = await TeacherService.createTeacher(
      { ...teacherInput("DT-R3"), currentDestinationId: dako.id },
      admin,
    );
    const w = await mkWeek(2096, 2);
    for (const t of [dest, kat, plain]) await setAvail(t.id, w.id, "AVAILABLE");

    const res = await SchedulingService.generateSchedule(w.id, admin);
    expect(res.inserted).toBe(3);
    const rows = await weekRows(w.id);
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.generationMode).toBeNull(); // plain AUTO — no duty mode
      expect(r.assignmentSource).toBe("AUTO");
    }
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "GENERATED_SCHEDULE"));
    expect(logs.length).toBe(1);
  });
});
