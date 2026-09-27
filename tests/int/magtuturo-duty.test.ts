import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import {
  assignMagtuturo,
  generateMagtuturoWeek,
  listMagtuturoForWeek,
} from "@/server/services/magtuturo.service";
import { isoWeekDates } from "@/lib/iso-week";

async function mkWeek(year: number, week: number) {
  const rows = await db.insert(schema.weeks).values({
    year,
    isoWeekNumber: week,
    ...isoWeekDates(year, week),
    status: "DRAFT",
  }).returning();
  return rows[0]!;
}

async function mkTeacher(
  code: string,
  over: Partial<{
    duty: string | null;
    currentDestinationId: string | null;
    status: string;
    dateOfOath: string | null;
  }> = {},
) {
  const rows = await db.insert(schema.teachers).values({
    teacherCode: code,
    firstName: "Teacher",
    lastName: code,
    language: "FILIPINO",
    duty: (over.duty ?? null) as "DESTINADO" | "KATUWANG" | null,
    currentDestinationId: over.currentDestinationId ?? null,
    status: over.status ?? "ACTIVE",
    dateOfOath: over.dateOfOath ?? null,
  }).returning();
  return rows[0]!;
}

async function mkDako(code: string, language = "FILIPINO") {
  const rows = await db.insert(schema.dako).values({
    dakoCode: code,
    name: `Dako ${code}`,
    address: "Addr",
    dateEstablished: "2000-01-01",
    worshipDay: "SUNDAY",
    worshipTime: "09:00",
    language,
  }).returning();
  return rows[0]!;
}

async function setAvail(teacherId: string, weekId: string, status: string, reason?: string) {
  await db.insert(schema.teacherAvailability).values({
    teacherId,
    weekId,
    availabilityStatus: status,
    reason: reason ?? null,
  });
}

async function setAvailFor(teacherIds: string[], weekIds: string[], status = "AVAILABLE") {
  for (const weekId of weekIds) {
    for (const teacherId of teacherIds) await setAvail(teacherId, weekId, status);
  }
}

function rowsByType(rows: Awaited<ReturnType<typeof listMagtuturoForWeek>>, type: "SUGO" | "RESERBA") {
  return rows.filter((row) => row.magType === type).sort((a, b) => a.seat - b.seat);
}

describe("Magtuturo rotation is independent of regular Suguan duty", () => {
  let adminId: string;

  beforeEach(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
  });

  afterAll(async () => {
    await teardown();
  });

  it("Test A/H: DESTINADO, KATUWANG, and no-duty candidates share one rotation regardless of destination/history", async () => {
    const dakoA = await mkDako("MN-A1");
    const dakoB = await mkDako("MN-B1");
    const destino = await mkTeacher("MN-DESTINADO", { duty: "DESTINADO", currentDestinationId: dakoA.id });
    const katuwang = await mkTeacher("MN-KATUWANG", { duty: "KATUWANG", currentDestinationId: dakoB.id });
    const plain = await mkTeacher("MN-PLAIN");
    const regularHistoryWeeks = [];
    for (let number = 1; number <= 5; number++) regularHistoryWeeks.push(await mkWeek(2090, number));
    for (const [index, historyWeek] of regularHistoryWeeks.entries()) {
      await db.insert(schema.assignments).values({
        weekId: historyWeek.id,
        teacherId: index < 2 ? katuwang.id : destino.id,
        dakoId: index < 2 ? dakoB.id : dakoA.id,
        assignmentType: "SUGO",
      });
    }
    const week = await mkWeek(2091, 2);
    await setAvailFor([destino.id, katuwang.id, plain.id], [week.id]);

    const generated = await generateMagtuturoWeek(week.id, { userId: adminId });
    expect(generated.created).toBe(3);
    const orderedTeachers = [destino, katuwang, plain].sort((a, b) => a.id.localeCompare(b.id));
    const selectedRows = (await listMagtuturoForWeek(week.id)).sort((a, b) =>
      a.magType === b.magType ? a.seat - b.seat : a.magType === "SUGO" ? -1 : 1);
    expect(selectedRows.map((row) => row.teacherId)).toEqual(orderedTeachers.map((teacher) => teacher.id));
  });

  it("changing only duty or Current Destination cannot change the selected Magtuturo candidate", async () => {
    const destination = await mkDako("MN-MOVED");
    const a = await mkTeacher("MN-EQUIV-A");
    const b = await mkTeacher("MN-EQUIV-B", { duty: "DESTINADO", currentDestinationId: destination.id });
    const c = await mkTeacher("MN-EQUIV-C", { duty: "KATUWANG", currentDestinationId: destination.id });
    const week = await mkWeek(2091, 3);
    await setAvailFor([a.id, b.id, c.id], [week.id]);

    const before = (await generateMagtuturoWeek(week.id, { userId: adminId })).created;
    expect(before).toBe(3);
    const selectionOrder = (rows: Awaited<ReturnType<typeof listMagtuturoForWeek>>) =>
      rows.slice().sort((a, b) => (a.magType === b.magType ? a.seat - b.seat : a.magType === "SUGO" ? -1 : 1))
        .map((row) => row.teacherId);
    const selectedBefore = selectionOrder(await listMagtuturoForWeek(week.id));

    await db.update(schema.teachers)
      .set({ duty: "KATUWANG", currentDestinationId: destination.id })
      .where(eq(schema.teachers.id, a.id));
    await db.update(schema.teachers)
      .set({ duty: null, currentDestinationId: null })
      .where(eq(schema.teachers.id, b.id));
    await db.update(schema.teachers)
      .set({ duty: "DESTINADO", currentDestinationId: null })
      .where(eq(schema.teachers.id, c.id));
    await db.delete(schema.magtuturoAssignments).where(eq(schema.magtuturoAssignments.weekId, week.id));

    expect((await generateMagtuturoWeek(week.id, { userId: adminId })).created).toBe(3);
    const selectedAfter = selectionOrder(await listMagtuturoForWeek(week.id));
    expect(selectedAfter).toEqual(selectedBefore);
  });

  it("Test B: the older last Magtuturo assignment ranks before a newer equal-count candidate", async () => {
    const older = await mkTeacher("MN-OLDER");
    const newer = await mkTeacher("MN-NEWER");
    const filler = await mkTeacher("MN-FILLER");
    const w1 = await mkWeek(2091, 4);
    const w2 = await mkWeek(2091, 5);
    const target = await mkWeek(2091, 6);
    await setAvailFor([older.id, newer.id, filler.id], [w1.id, w2.id, target.id]);
    await db.insert(schema.magtuturoAssignments).values([
      { weekId: w1.id, teacherId: older.id, magType: "SUGO", seat: 1, assignmentSource: "MANUAL", assignedAt: new Date("2024-01-10T12:00:00Z") },
      { weekId: w2.id, teacherId: older.id, magType: "SUGO", seat: 1, assignmentSource: "MANUAL", assignedAt: new Date("2024-01-10T12:00:00Z") },
      { weekId: w1.id, teacherId: newer.id, magType: "SUGO", seat: 2, assignmentSource: "MANUAL", assignedAt: new Date("2024-01-20T12:00:00Z") },
      { weekId: w2.id, teacherId: newer.id, magType: "SUGO", seat: 2, assignmentSource: "MANUAL", assignedAt: new Date("2024-01-20T12:00:00Z") },
      { weekId: w1.id, teacherId: filler.id, magType: "RESERBA", seat: 1, assignmentSource: "MANUAL", assignedAt: new Date("2024-01-25T12:00:00Z") },
      { weekId: w2.id, teacherId: filler.id, magType: "RESERBA", seat: 1, assignmentSource: "MANUAL", assignedAt: new Date("2024-01-25T12:00:00Z") },
    ]);

    expect((await generateMagtuturoWeek(target.id, { userId: adminId })).created).toBe(3);
    const sugo = rowsByType(await listMagtuturoForWeek(target.id), "SUGO");
    expect(sugo.filter((row) => [older.id, newer.id].includes(row.teacherId)).map((row) => row.teacherId))
      .toEqual([older.id, newer.id]);
  });

  it("Test C/regression: generated Magtuturo counts immediately affect each following week's unified rotation", async () => {
    const dutyDako = await mkDako("MR-DUTY");
    const historyWeek = await mkWeek(2091, 1);
    const teachers: Array<typeof schema.teachers.$inferSelect> = [];
    for (let i = 1; i <= 25; i++) {
      teachers.push(await mkTeacher(`MR-${String(i).padStart(3, "0")}`, {
        ...(i === 1 || i === 2 ? { duty: "KATUWANG", currentDestinationId: dutyDako.id } : {}),
      }));
    }
    await db.update(schema.teachers)
      .set({ status: "INACTIVE", dateInactive: "2092-01-01", inactiveReason: "test fixture" })
      .where(eq(schema.teachers.id, teachers[22]!.id));
    // Teacher 23 is master-inactive; teacher 24 is NOT_ENCODED; teacher 25
    // receives a regular English-dako assignment below.
    const englishDako = await mkDako("MR-EN", "ENGLISH");
    await db.insert(schema.magtuturoAssignments).values([
      { weekId: historyWeek.id, teacherId: teachers[0]!.id, magType: "SUGO", seat: 1, assignmentSource: "MANUAL", assignedAt: new Date("2024-01-01T00:00:00Z") },
      { weekId: historyWeek.id, teacherId: teachers[1]!.id, magType: "SUGO", seat: 2, assignmentSource: "MANUAL", assignedAt: new Date("2024-01-01T00:00:00Z") },
    ]);
    const weeks: Array<typeof schema.weeks.$inferSelect> = [];
    for (const number of [20, 21, 22, 23]) weeks.push(await mkWeek(2092, number));
    for (const [weekIndex, week] of weeks.entries()) {
      for (const [index, teacher] of teachers.entries()) {
        if (index === 23) continue; // NOT_ENCODED is a hard exclusion
        if (index === 22) continue; // master INACTIVE is hard-excluded regardless of availability
        await setAvail(teacher.id, week.id, weekIndex > 0 && (index === 0 || index === 1) ? "ABSENT" : "AVAILABLE");
      }
    }
    for (const week of weeks) {
      await db.insert(schema.assignments).values({
        weekId: week.id,
        teacherId: teachers[24]!.id,
        dakoId: englishDako.id,
        assignmentType: "SUGO",
      });
    }

    const perWeek: Array<Awaited<ReturnType<typeof listMagtuturoForWeek>>> = [];
    const cumulative = new Map<string, number>([[teachers[0]!.id, 1], [teachers[1]!.id, 1]]);
    for (let index = 0; index < weeks.length; index++) {
      const week = weeks[index]!;
      const historyBefore = await db.select().from(schema.magtuturoAssignments);
      const countsBefore = new Map<string, number>();
      const lastBefore = new Map<string, number>();
      for (const row of historyBefore) {
        countsBefore.set(row.teacherId, (countsBefore.get(row.teacherId) ?? 0) + 1);
        lastBefore.set(row.teacherId, Math.max(lastBefore.get(row.teacherId) ?? 0, row.assignedAt.getTime()));
      }
      const priorRows = index === 0 ? [] : perWeek[index - 1]!;
      const promoted = priorRows.filter((row) => row.magType === "RESERBA").map((row) => row.teacherId);
      const absent = await db.select().from(schema.teacherAvailability)
        .where(and(eq(schema.teacherAvailability.weekId, week.id), eq(schema.teacherAvailability.availabilityStatus, "ABSENT")));
      const absentIds = new Set(absent.map((row) => row.teacherId));
      const carried = priorRows
        .filter((row) => row.magType === "SUGO" && absentIds.has(row.teacherId))
        .map((row) => row.teacherId);
      const expectedRotation = teachers
        .filter((teacher, teacherIndex) => teacher.status === "ACTIVE" && teacherIndex !== 22 && teacherIndex !== 23 && teacherIndex !== 24 && !promoted.includes(teacher.id) && !carried.includes(teacher.id))
        .sort((a, b) => (countsBefore.get(a.id) ?? 0) - (countsBefore.get(b.id) ?? 0) ||
          (lastBefore.get(a.id) ?? 0) - (lastBefore.get(b.id) ?? 0) || a.id.localeCompare(b.id));
      const generated = await generateMagtuturoWeek(week.id, { userId: adminId });
      expect(generated.created).toBe(6);
      const rows = await listMagtuturoForWeek(week.id);
      expect(rows).toHaveLength(6);
      expect(rowsByType(rows, "SUGO")).toHaveLength(4);
      expect(rowsByType(rows, "RESERBA")).toHaveLength(2);
      perWeek.push(rows);
      const orderedRows = rows.slice().sort((a, b) =>
        a.magType === b.magType ? a.seat - b.seat : a.magType === "SUGO" ? -1 : 1);
      const rotationRows = orderedRows.filter((row) => !promoted.includes(row.teacherId) && !carried.includes(row.teacherId));
      expect(rotationRows.map((row) => row.teacherId), JSON.stringify({
        week: week.isoWeekNumber,
        actual: rotationRows.map((row) => row.teacherCode),
        expected: expectedRotation.slice(0, rotationRows.length).map((teacher) => teacher.teacherCode),
        promoted: promoted.map((id) => teachers.find((teacher) => teacher.id === id)?.teacherCode),
        carried: carried.map((id) => teachers.find((teacher) => teacher.id === id)?.teacherCode),
      })).toEqual(expectedRotation.slice(0, rotationRows.length).map((teacher) => teacher.id));
      for (const row of rows) cumulative.set(row.teacherId, (cumulative.get(row.teacherId) ?? 0) + 1);
    }
    expect(perWeek.flat()).toHaveLength(24);
    expect(new Set(perWeek.flat().map((row) => row.teacherId)).size).toBeLessThanOrEqual(22);
    for (const rows of perWeek) expect(new Set(rows.map((row) => row.teacherId)).size).toBe(6);
    expect(perWeek.flat().some((row) => row.teacherId === teachers[22]!.id)).toBe(false);
    expect(perWeek.flat().some((row) => row.teacherId === teachers[23]!.id)).toBe(false);
    expect(perWeek.flat().some((row) => row.teacherId === teachers[24]!.id)).toBe(false);

    for (let index = 0; index < weeks.length; index++) {
      const currentRows = await db.select().from(schema.magtuturoAssignments)
        .where(eq(schema.magtuturoAssignments.weekId, weeks[index]!.id));
      expect(currentRows).toHaveLength(6);
      if (index < weeks.length - 1) {
        const visibleHistory = await db.select().from(schema.magtuturoAssignments);
        expect(visibleHistory.filter((row) => weeks.slice(0, index + 1).some((w) => w.id === row.weekId)))
          .toHaveLength((index + 1) * 6);
      }
    }
    expect([...cumulative.values()].reduce((sum, count) => sum + count, 0)).toBe(26); // two seeded historical Magtuturo seats + 24 generated
    // Katuwang status did not reserve the first two SUGO seats: zero-history
    // non-Katuwang teachers rank ahead of their existing Magtuturo history.
    expect(perWeek[0]!.some((row) => row.teacherId === teachers[0]!.id)).toBe(false);
    expect(perWeek[0]!.some((row) => row.teacherId === teachers[1]!.id)).toBe(false);
  });

  it("Test E/F: SUGO+ABSENT continuity and RESERBA+not-ABSENT promotion still precede rotation", async () => {
    const carried = await mkTeacher("MC-CARRY");
    const promoted = await mkTeacher("MC-PROMOTE");
    const ordinary = await mkTeacher("MC-ORDINARY");
    const w1 = await mkWeek(2093, 10);
    const w2 = await mkWeek(2093, 11);
    await setAvailFor([carried.id, promoted.id, ordinary.id], [w1.id, w2.id]);
    await db.insert(schema.magtuturoAssignments).values([
      { weekId: w1.id, teacherId: carried.id, magType: "SUGO", seat: 1, assignmentSource: "MANUAL" },
      { weekId: w1.id, teacherId: promoted.id, magType: "RESERBA", seat: 1, assignmentSource: "MANUAL" },
    ]);
    await db.update(schema.teacherAvailability)
      .set({ availabilityStatus: "ABSENT", reason: "ongoing" })
      .where(and(eq(schema.teacherAvailability.teacherId, carried.id), eq(schema.teacherAvailability.weekId, w2.id)));

    const generated = await generateMagtuturoWeek(w2.id, { userId: adminId });
    expect(generated.detail.join(" ")).toContain("21.4");
    expect(generated.detail.join(" ")).toContain("21.5");
    const sugo = rowsByType(await listMagtuturoForWeek(w2.id), "SUGO");
    expect(sugo.slice(0, 2).map((row) => row.teacherId)).toEqual([carried.id, promoted.id]);
  });

  it("Test G: master inactive, NOT_ENCODED, weekly inactive, oath date, and English dako remain hard exclusions", async () => {
    const masterInactive = await mkTeacher("MH-MASTER");
    await db.update(schema.teachers)
      .set({ status: "INACTIVE", dateInactive: "2094-01-01", inactiveReason: "test fixture" })
      .where(eq(schema.teachers.id, masterInactive.id));
    const notEncoded = await mkTeacher("MH-NOT-ENCODED");
    const weeklyInactive = await mkTeacher("MH-WEEKLY");
    const oathFuture = await mkTeacher("MH-OATH", { dateOfOath: "2095-01-01" });
    const english = await mkTeacher("MH-ENGLISH");
    const good = await mkTeacher("MH-GOOD");
    const englishDako = await mkDako("MH-EN", "ENGLISH");
    const week = await mkWeek(2094, 5);
    await setAvailFor([masterInactive.id, weeklyInactive.id, oathFuture.id, english.id, good.id], [week.id]);
    await db.update(schema.teacherAvailability)
      .set({ availabilityStatus: "INACTIVE" })
      .where(and(eq(schema.teacherAvailability.teacherId, weeklyInactive.id), eq(schema.teacherAvailability.weekId, week.id)));
    await db.insert(schema.assignments).values({
      weekId: week.id,
      teacherId: english.id,
      dakoId: englishDako.id,
      assignmentType: "SUGO",
    });

    const result = await generateMagtuturoWeek(week.id, { userId: adminId });
    expect(result.created).toBe(1);
    expect((await listMagtuturoForWeek(week.id)).map((row) => row.teacherId)).toEqual([good.id]);
  });

  it("RESERBA+ABSENT is not promoted and remains behind lower-count candidates", async () => {
    const carried = await mkTeacher("MA-CARRY");
    const promoted = await mkTeacher("MA-PROMOTE");
    const absentReserve = await mkTeacher("MA-ABSENT-RESERBA");
    const rotation: Array<typeof schema.teachers.$inferSelect> = [];
    for (let index = 1; index <= 4; index++) rotation.push(await mkTeacher(`MA-ROT-${index}`));
    const previous = await mkWeek(2094, 15);
    const current = await mkWeek(2094, 16);
    const all = [carried, promoted, absentReserve, ...rotation];
    await setAvailFor(all.map((teacher) => teacher.id), [previous.id, current.id]);
    await db.insert(schema.magtuturoAssignments).values([
      { weekId: previous.id, teacherId: carried.id, magType: "SUGO", seat: 1, assignmentSource: "MANUAL" },
      { weekId: previous.id, teacherId: promoted.id, magType: "RESERBA", seat: 1, assignmentSource: "MANUAL" },
      { weekId: previous.id, teacherId: absentReserve.id, magType: "RESERBA", seat: 2, assignmentSource: "MANUAL" },
    ]);
    await db.update(schema.teacherAvailability)
      .set({ availabilityStatus: "ABSENT" })
      .where(and(eq(schema.teacherAvailability.teacherId, carried.id), eq(schema.teacherAvailability.weekId, current.id)));
    await db.update(schema.teacherAvailability)
      .set({ availabilityStatus: "ABSENT" })
      .where(and(eq(schema.teacherAvailability.teacherId, absentReserve.id), eq(schema.teacherAvailability.weekId, current.id)));

    const result = await generateMagtuturoWeek(current.id, { userId: adminId });
    expect(result.created).toBe(6);
    expect(result.detail.filter((item) => item.includes("21.5"))).toHaveLength(1);
    const rows = await listMagtuturoForWeek(current.id);
    expect(rows.some((row) => row.teacherId === carried.id && row.magType === "SUGO")).toBe(true);
    expect(rows.some((row) => row.teacherId === promoted.id && row.magType === "SUGO")).toBe(true);
    expect(rows.some((row) => row.teacherId === absentReserve.id)).toBe(false);
    expect(rotation.every((teacher) => rows.some((row) => row.teacherId === teacher.id))).toBe(true);
  });

  it("Test 6: repeated Katuwang candidates rotate with all other eligible teachers, not ahead of them", async () => {
    const dako = await mkDako("MT-D1");
    const historyWeek = await mkWeek(2095, 27);
    const recencyWeek = await mkWeek(2095, 28);
    const teachers: Array<typeof schema.teachers.$inferSelect> = [];
    for (let i = 1; i <= 8; i++) {
      teachers.push(await mkTeacher(`MT-${i}`, i <= 2
        ? { duty: "KATUWANG", currentDestinationId: dako.id }
        : {}));
    }
    const weeks: Array<typeof schema.weeks.$inferSelect> = [];
    for (let number = 30; number <= 33; number++) weeks.push(await mkWeek(2095, number));
    await setAvailFor(teachers.map((teacher) => teacher.id), [historyWeek.id, recencyWeek.id, ...weeks.map((week) => week.id)]);
    await db.insert(schema.magtuturoAssignments).values([
      ...teachers.slice(2).map((teacher, index) => ({
        weekId: historyWeek.id,
        teacherId: teacher.id,
        magType: index < 4 ? "SUGO" : "RESERBA",
        seat: index < 4 ? index + 1 : index - 3,
        assignmentSource: "MANUAL",
        assignedAt: new Date("2024-01-01T12:00:00Z"),
      })),
      ...teachers.slice(0, 2).map((teacher, index) => ({
        weekId: recencyWeek.id,
        teacherId: teacher.id,
        magType: "SUGO",
        seat: index + 1,
        assignmentSource: "MANUAL",
        assignedAt: new Date("2024-02-01T12:00:00Z"),
      })),
    ]);

    const selectedByWeek: Array<Awaited<ReturnType<typeof listMagtuturoForWeek>>> = [];
    for (const week of weeks) {
      expect((await generateMagtuturoWeek(week.id, { userId: adminId })).created).toBe(6);
      selectedByWeek.push(await listMagtuturoForWeek(week.id));
    }
    for (const teacher of teachers.slice(0, 2)) {
      expect(selectedByWeek[0]!.some((row) => row.teacherId === teacher.id)).toBe(false);
      expect(
        selectedByWeek.slice(1).some((rows) => rows.some((row) => row.teacherId === teacher.id)),
        `Katuwang candidate ${teacher.teacherCode} should enter the same Magtuturo rotation after counts and recency are applied: ${JSON.stringify(selectedByWeek.map((rows) => rows.map((row) => row.teacherCode)))}`,
      ).toBe(true);
    }
    for (const weekRows of selectedByWeek.slice(1)) {
      expect(new Set(weekRows.map((row) => row.teacherId)).size).toBe(6);
    }
  });

  it("manual Magtuturo assignment remains allowed regardless of regular Suguan duty", async () => {
    const dako = await mkDako("MM-D1");
    const dest = await mkTeacher("MM-DESTINADO", { duty: "DESTINADO", currentDestinationId: dako.id });
    const week = await mkWeek(2096, 2);
    await setAvail(dest.id, week.id, "AVAILABLE");

    const out = await assignMagtuturo({
      weekId: week.id,
      teacherId: dest.id,
      magType: "SUGO",
      seat: 1,
      user: { userId: adminId },
    });
    expect(out.ok).toBe(true);
    expect((await listMagtuturoForWeek(week.id)).find((row) => row.magType === "SUGO" && row.seat === 1)!.teacherCode)
      .toBe("MM-DESTINADO");
  });
});
