import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { isoWeekDates } from "@/lib/iso-week";
import {
  assignMagtuturo,
  generateMagtuturoMonth,
  generateMagtuturoWeek,
  listMagtuturoForWeek,
  weeksOverlappingMonth,
} from "@/server/services/magtuturo.service";
import * as schema from "@/server/db/schema";
import { db, resetTestDb, seedAdmin, teardown } from "./helpers";

async function createTeachers(count: number) {
  const teachers = [];
  for (let i = 1; i <= count; i++) {
    const rows = await db.insert(schema.teachers).values({
      teacherCode: `ME-${String(i).padStart(3, "0")}`,
      firstName: "Magtuturo",
      lastName: `Teacher ${i}`,
      language: "FILIPINO",
    }).returning();
    teachers.push(rows[0]!);
  }
  return teachers;
}

async function seedAvailability(teacherIds: string[], weekIds: string[]) {
  for (const weekId of weekIds) {
    for (const teacherId of teacherIds) {
      await db.insert(schema.teacherAvailability).values({
        teacherId,
        weekId,
        availabilityStatus: "AVAILABLE",
      });
    }
  }
}

async function createWeek(year: number, week: number, status = "DRAFT") {
  const dates = isoWeekDates(year, week);
  const rows = await db.insert(schema.weeks).values({ year, isoWeekNumber: week, ...dates, status }).returning();
  return rows[0]!;
}

describe("Magtuturo management safeguards", () => {
  let adminId: string;

  beforeEach(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
  });

  afterAll(async () => {
    await teardown();
  });

  it("generates four SUGO plus two RESERBA and regenerates without losing manual seats", async () => {
    const teachers = await createTeachers(8);
    const week = await createWeek(2091, 8);
    await seedAvailability(teachers.map((teacher) => teacher.id), [week.id]);

    const generated = await generateMagtuturoWeek(week.id, { userId: adminId });
    expect(generated.created).toBe(6);
    expect(generated.skipped).toBe(false);
    let rows = await listMagtuturoForWeek(week.id);
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.magType === "SUGO")).toHaveLength(4);
    expect(rows.filter((row) => row.magType === "RESERBA")).toHaveLength(2);
    expect(new Set(rows.map((row) => row.magType))).toEqual(new Set(["SUGO", "RESERBA"]));

    const unseatedTeacher = teachers.find((teacher) => !rows.some((row) => row.teacherId === teacher.id))!;
    const manual = await assignMagtuturo({
      weekId: week.id,
      teacherId: unseatedTeacher.id,
      magType: "SUGO",
      seat: 1,
      user: { userId: adminId },
    });
    expect(manual.ok).toBe(true);

    const duplicate = await assignMagtuturo({
      weekId: week.id,
      teacherId: unseatedTeacher.id,
      magType: "RESERBA",
      seat: 1,
      user: { userId: adminId },
    });
    expect(duplicate).toMatchObject({ ok: false, violatedRules: ["ALREADY_ASSIGNED_MAGTUTURO"] });

    const regenerated = await generateMagtuturoWeek(week.id, { userId: adminId });
    expect(regenerated.skipped).toBe(false);
    rows = await listMagtuturoForWeek(week.id);
    expect(rows).toHaveLength(6);
    expect(rows.find((row) => row.magType === "SUGO" && row.seat === 1)).toMatchObject({
      teacherId: unseatedTeacher.id,
      assignmentSource: "MANUAL",
    });
    expect(rows.filter((row) => row.assignmentSource === "AUTO")).toHaveLength(5);

    const auditRows = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "MAGTUTURO_GENERATED"));
    expect(auditRows).toHaveLength(2);
    expect(auditRows[1]!.oldValue).toMatchObject({ previousAutoAssignments: expect.any(Array) });
    expect(auditRows[1]!.newValue).toMatchObject({ sugo: 4, reserba: 2, preservedManual: 1 });
  });

  it("skips regeneration without touching a manual seat that has become ineligible", async () => {
    const teachers = await createTeachers(7);
    const week = await createWeek(2092, 8);
    await seedAvailability(teachers.map((teacher) => teacher.id), [week.id]);
    const manual = await assignMagtuturo({
      weekId: week.id,
      teacherId: teachers[0]!.id,
      magType: "SUGO",
      seat: 1,
      user: { userId: adminId },
    });
    expect(manual.ok).toBe(true);

    await db.update(schema.teacherAvailability)
      .set({ availabilityStatus: "INACTIVE" })
      .where(and(eq(schema.teacherAvailability.teacherId, teachers[0]!.id), eq(schema.teacherAvailability.weekId, week.id)));
    const before = await listMagtuturoForWeek(week.id);
    const result = await generateMagtuturoWeek(week.id, { userId: adminId });
    expect(result).toMatchObject({ skipped: true, created: 0 });
    expect(result.reason).toContain("Manual SUGO 1 conflicts with eligibility");
    expect(await listMagtuturoForWeek(week.id)).toEqual(before);
  });

  it("runs Generate Monthly week-by-week for every overlapping ISO week", async () => {
    const teachers = await createTeachers(8);
    const targets = weeksOverlappingMonth(2097, 1);
    const targetWeeks = [];
    for (const target of targets) targetWeeks.push(await createWeek(target.year, target.week));
    await seedAvailability(teachers.map((teacher) => teacher.id), targetWeeks.map((week) => week.id));

    const result = await generateMagtuturoMonth(2097, 1, { userId: adminId });
    expect(result).toMatchObject({ year: 2097, month: 1, created: targets.length * 6 });
    expect(result.weeks).toHaveLength(targets.length);
    expect(result.weeks.every((week) => !week.skipped && week.created === 6)).toBe(true);

    for (const week of targetWeeks) {
      const rows = await listMagtuturoForWeek(week.id);
      expect(rows).toHaveLength(6);
      expect(rows.filter((row) => row.magType === "SUGO")).toHaveLength(4);
      expect(rows.filter((row) => row.magType === "RESERBA")).toHaveLength(2);
      expect((await db.select().from(schema.weeks).where(eq(schema.weeks.id, week.id)))[0]!.status).toBe("DRAFT");
    }
  });

  it("generates October 2026 ISO weeks 40-44 with 30 sequential Magtuturo slots", async () => {
    const teachers = await createTeachers(8);
    const targets = weeksOverlappingMonth(2026, 10);
    expect(targets.map((week) => week.week)).toEqual([40, 41, 42, 43, 44]);
    const targetWeeks = [];
    for (const target of targets) targetWeeks.push(await createWeek(target.year, target.week));
    await seedAvailability(teachers.map((teacher) => teacher.id), targetWeeks.map((week) => week.id));

    const result = await generateMagtuturoMonth(2026, 10, { userId: adminId });
    expect(result.created).toBe(30);
    expect(result.weeks.map((week) => week.isoWeekNumber)).toEqual([40, 41, 42, 43, 44]);
    expect(result.weeks.map((week) => week.created)).toEqual([6, 6, 6, 6, 6]);
    for (const week of targetWeeks) {
      const rows = await listMagtuturoForWeek(week.id);
      expect(rows).toHaveLength(6);
      expect(rows.filter((row) => row.magType === "SUGO")).toHaveLength(4);
      expect(rows.filter((row) => row.magType === "RESERBA")).toHaveLength(2);
    }
  });

  it("does not regenerate populated or lifecycle-locked weeks during monthly processing", async () => {
    const teachers = await createTeachers(8);
    const targets = weeksOverlappingMonth(2098, 2);
    const first = await createWeek(targets[0]!.year, targets[0]!.week);
    const locked = await createWeek(targets[1]!.year, targets[1]!.week, "FINALIZED");
    const remaining = [];
    for (const target of targets.slice(2)) remaining.push(await createWeek(target.year, target.week));
    await seedAvailability(teachers.map((teacher) => teacher.id), [first.id, locked.id, ...remaining.map((week) => week.id)]);

    const manualTeacher = teachers[0]!;
    await db.insert(schema.magtuturoAssignments).values({
      weekId: first.id,
      teacherId: manualTeacher.id,
      magType: "SUGO",
      seat: 1,
      assignmentSource: "MANUAL",
    });
    const lockedTeacher = teachers[1]!;
    await db.insert(schema.magtuturoAssignments).values({
      weekId: locked.id,
      teacherId: lockedTeacher.id,
      magType: "RESERBA",
      seat: 1,
      assignmentSource: "MANUAL",
    });

    const result = await generateMagtuturoMonth(2098, 2, { userId: adminId });
    const firstResult = result.weeks.find((week) => week.weekId === first.id)!;
    const lockedResult = result.weeks.find((week) => week.weekId === locked.id)!;
    expect(firstResult).toMatchObject({ skipped: true, created: 0 });
    expect(firstResult.reason).toContain("already has Magtuturo assignments");
    expect(lockedResult).toMatchObject({ skipped: true, created: 0 });
    expect(lockedResult.reason).toContain("FINALIZED");
    expect(await listMagtuturoForWeek(first.id)).toMatchObject([
      { teacherId: manualTeacher.id, magType: "SUGO", seat: 1, assignmentSource: "MANUAL" },
    ]);
    expect(await listMagtuturoForWeek(locked.id)).toMatchObject([
      { teacherId: lockedTeacher.id, magType: "RESERBA", seat: 1, assignmentSource: "MANUAL" },
    ]);
    for (const week of remaining) {
      expect(await listMagtuturoForWeek(week.id)).toHaveLength(6);
    }
  });
});
