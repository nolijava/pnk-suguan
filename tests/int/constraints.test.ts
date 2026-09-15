import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, sql, db } from "./helpers";
import * as schema from "@/server/db/schema";

beforeAll(async () => {
  await resetTestDb();
  await seedAdmin();
});

afterAll(async () => {
  await teardown();
});

async function createDako(code: string, language = "FILIPINO") {
  const rows = await db
    .insert(schema.dako)
    .values({ dakoCode: code, name: `Dako ${code}`, address: "Test Address 1", dateEstablished: "2010-05-01", worshipDay: "SUNDAY", worshipTime: "09:00", language })
    .returning();
  return rows[0]!;
}

async function createTeacher(code: string, language = "FILIPINO") {
  const rows = await db
    .insert(schema.teachers)
    .values({ teacherCode: code, firstName: "Juan", lastName: code, language })
    .returning();
  return rows[0]!;
}

async function createWeek(year: number, week: number) {
  const { isoWeekDates } = await import("@/lib/iso-week");
  const d = isoWeekDates(year, week);
  const rows = await db.insert(schema.weeks).values({ year, isoWeekNumber: week, ...d }).returning();
  return rows[0]!;
}

describe("unique constraints (§21)", () => {
  it("rejects duplicate teacher_code", async () => {
    await createTeacher("T-UC1");
    await expect(createTeacher("T-UC1")).rejects.toThrow();
  });

  it("rejects duplicate dako_code", async () => {
    await createDako("D-UC1");
    await expect(createDako("D-UC1")).rejects.toThrow();
  });

  it("rejects duplicate year+iso_week", async () => {
    await createWeek(2099, 5);
    await expect(createWeek(2099, 5)).rejects.toThrow();
  });

  it("rejects duplicate availability for same teacher+week", async () => {
    const t = await createTeacher("T-AV");
    const w = await createWeek(2098, 10);
    await db.insert(schema.teacherAvailability).values({ teacherId: t.id, weekId: w.id, availabilityStatus: "AVAILABLE" });
    await expect(
      db.insert(schema.teacherAvailability).values({ teacherId: t.id, weekId: w.id, availabilityStatus: "ABSENT" }),
    ).rejects.toThrow();
  });

  it("rejects one teacher twice in the same week (different dako/type)", async () => {
    const t = await createTeacher("T-DUP");
    const d1 = await createDako("D-DUP1");
    const d2 = await createDako("D-DUP2");
    const w = await createWeek(2097, 7);
    await db.insert(schema.assignments).values({ weekId: w.id, dakoId: d1.id, teacherId: t.id, assignmentType: "SUGO" });
    await expect(
      db.insert(schema.assignments).values({ weekId: w.id, dakoId: d2.id, teacherId: t.id, assignmentType: "RESERBA" }),
    ).rejects.toThrow();
  });

  it("rejects duplicate dako+type slot in the same week", async () => {
    const t1 = await createTeacher("T-S1");
    const t2 = await createTeacher("T-S2");
    const d = await createDako("D-SLOT");
    const w = await createWeek(2096, 3);
    await db.insert(schema.assignments).values({ weekId: w.id, dakoId: d.id, teacherId: t1.id, assignmentType: "SUGO" });
    await expect(
      db.insert(schema.assignments).values({ weekId: w.id, dakoId: d.id, teacherId: t2.id, assignmentType: "SUGO" }),
    ).rejects.toThrow();
  });
});

describe("CHECK constraints (§32)", () => {
  /** Drizzle wraps driver errors; walk to the postgres cause for the constraint name. */
  async function expectCheckViolation(fn: () => Promise<unknown>, constraint: string) {
    try {
      await fn();
      expect.unreachable(`expected ${constraint} violation`);
    } catch (err: unknown) {
      let e: unknown = err;
      let found = false;
      while (e instanceof Error) {
        if ((e as { code?: string }).code === "23514" && e.message.includes(constraint)) { found = true; break; }
        e = (e as { cause?: unknown }).cause;
        if (!e) break;
      }
      expect(found, `expected 23514 violation of ${constraint}`).toBe(true);
    }
  }

  it("rejects bad assignment_type", async () => {
    const t = await createTeacher("T-CK");
    const d = await createDako("D-CK");
    const w = await createWeek(2095, 1);
    await expectCheckViolation(
      () => db.insert(schema.assignments).values({ weekId: w.id, dakoId: d.id, teacherId: t.id, assignmentType: "PENDING" as "SUGO" }),
      "assignments_type_check",
    );
  });

  it("rejects inactive teacher without date_inactive", async () => {
    await expectCheckViolation(
      () => db.insert(schema.teachers).values({ teacherCode: "T-NODATE", firstName: "A", lastName: "B", language: "FILIPINO", status: "INACTIVE" }),
      "teachers_inactive_coherence_check",
    );
  });

  it("rejects bad language", async () => {
    await expectCheckViolation(
      () => db.insert(schema.teachers).values({ teacherCode: "T-LANG", firstName: "A", lastName: "B", language: "CEBUANO" }),
      "teachers_language_check",
    );
  });
});

describe("assignment history trigger (§25)", () => {
  it("records CREATED row on insert and UPDATED rows on change", async () => {
    const t1 = await createTeacher("T-H1");
    const t2 = await createTeacher("T-H2");
    const d = await createDako("D-H1");
    const w = await createWeek(2094, 20);
    const [a] = await db.insert(schema.assignments).values({ weekId: w.id, dakoId: d.id, teacherId: t1.id, assignmentType: "SUGO" }).returning();
    const assignmentId = a!.id;

    let hist = await db.select().from(schema.assignmentHistory).where(drizzleSql`assignment_id = ${assignmentId}`);
    expect(hist).toHaveLength(1);
    expect(hist[0]!.changeReason).toBe("CREATED");
    expect(hist[0]!.newTeacherId).toBe(t1.id);

    await db.update(schema.assignments).set({ teacherId: t2.id }).where(drizzleSql`id = ${assignmentId}`);
    hist = await db.select().from(schema.assignmentHistory).where(drizzleSql`assignment_id = ${assignmentId}`);
    expect(hist).toHaveLength(2);
    expect(hist[1]!.oldTeacherId).toBe(t1.id);
    expect(hist[1]!.newTeacherId).toBe(t2.id);
    expect(hist[1]!.changeReason).toBe("UPDATED");
  });

  it("is append-only (§25/§26): UPDATE and DELETE rejected", async () => {
    const t = await createTeacher("T-AO");
    const d = await createDako("D-AO");
    const w = await createWeek(2093, 11);
    const [a] = await db.insert(schema.assignments).values({ weekId: w.id, dakoId: d.id, teacherId: t.id, assignmentType: "RESERBA" }).returning();
    const histRows = await db.select().from(schema.assignmentHistory).where(drizzleSql`assignment_id = ${a!.id}`);
    await expect(db.update(schema.assignmentHistory).set({ changeReason: "tampered" }).where(drizzleSql`id = ${histRows[0]!.id}`)).rejects.toThrow();
    await expect(db.delete(schema.assignmentHistory).where(drizzleSql`id = ${histRows[0]!.id}`)).rejects.toThrow();
  });
});

describe("referential integrity (§30)", () => {
  it("rejects assignment to nonexistent week/dako/teacher", async () => {
    await expect(
      db.insert(schema.assignments).values({
        weekId: "00000000-0000-0000-0000-000000000001",
        dakoId: "00000000-0000-0000-0000-000000000002",
        teacherId: "00000000-0000-0000-0000-000000000003",
        assignmentType: "SUGO",
      }),
    ).rejects.toThrow();
  });

  it("kept dako stays referenceable by historical assignments after disable (§13)", async () => {
    const t = await createTeacher("T-HIST");
    const d = await createDako("D-HIST");
    const w = await createWeek(2092, 9);
    const [a] = await db.insert(schema.assignments).values({ weekId: w.id, dakoId: d.id, teacherId: t.id, assignmentType: "SUGO" }).returning();
    const assignmentId = a!.id;

    await db.update(schema.dako).set({ status: "DISABLED", dateDisabled: "2026-09-15", disableReason: "closed" }).where(drizzleSql`id = ${d.id}`);
    const still = await db.select().from(schema.assignments).where(drizzleSql`id = ${assignmentId}`);
    expect(still).toHaveLength(1);
    // disabled dako not usable for NEW assignments in a NEW week via service rules (covered in service tests)
  });
});

describe("updated_at trigger", () => {
  it("bumps updated_at on modify", async () => {
    const t = await createTeacher("T-UPD");
    await new Promise((r) => setTimeout(r, 50));
    await db.update(schema.teachers).set({ remarks: "changed" }).where(drizzleSql`id = ${t.id}`);
    const rows = await db.select().from(schema.teachers).where(drizzleSql`id = ${t.id}`);
    expect(rows[0]!.updatedAt.getTime()).toBeGreaterThan(t.updatedAt.getTime());
  });
});

describe("seed data (§38)", () => {
  it("has exactly the three initial roles", async () => {
    const rows = await db.select().from(schema.roles).orderBy(schema.roles.code);
    expect(rows.map((r) => r.code)).toEqual(["ADMIN", "SCHEDULER", "VIEWER"]);
  });
});
