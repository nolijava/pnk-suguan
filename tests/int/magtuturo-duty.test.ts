/**
 * Guro Duty × Magtuturo (Update #21 extension) — integration:
 *  - eligible KATUWANG take the teaching seats first (per-dako duty rosters),
 *  - fair rotation WITHIN a dako and round-robin ACROSS dakos,
 *  - seats not covered by Katuwang fall back to the legacy global rotation,
 *  - continuity (21.4/21.5) still beats the duty rotation,
 *  - hard rules (21.6-21.8) still outrank duty,
 *  - manual assignment stays duty-agnostic (21.10).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import {
  assignMagtuturo,
  generateMagtuturoWeek,
  listMagtuturoForWeek,
} from "@/server/services/magtuturo.service";

function weekStart(year: number, week: number): string {
  const jan4 = new Date(`${year}-01-04T00:00:00Z`);
  const dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (dow - 1) + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

async function mkWeek(year: number, week: number) {
  const start = weekStart(year, week);
  const endD = new Date(`${start}T00:00:00Z`);
  endD.setUTCDate(endD.getUTCDate() + 6);
  const rows = await db
    .insert(schema.weeks)
    .values({ year, isoWeekNumber: week, startDate: start, endDate: endD.toISOString().slice(0, 10), status: "DRAFT" })
    .returning();
  return rows[0]!;
}

async function mkTeacher(
  code: string,
  over: Partial<{ duty: string | null; currentDestinationId: string | null; status: string }> = {},
) {
  const rows = await db
    .insert(schema.teachers)
    .values({
      teacherCode: code,
      firstName: "T",
      lastName: code,
      language: "FILIPINO",
      duty: (over.duty ?? null) as "DESTINADO" | "KATUWANG" | null,
      currentDestinationId: over.currentDestinationId ?? null,
    })
    .returning();
  return rows[0]!;
}

async function mkDako(code: string) {
  const rows = await db
    .insert(schema.dako)
    .values({
      dakoCode: code,
      name: `Dako ${code}`,
      address: "Addr",
      dateEstablished: "2000-01-01",
      worshipDay: "SUNDAY",
      worshipTime: "09:00",
      language: "FILIPINO",
    })
    .returning();
  return rows[0]!;
}

async function setAvail(teacherId: string, weekId: string, status: string, reason?: string) {
  await db
    .insert(schema.teacherAvailability)
    .values({ teacherId, weekId, availabilityStatus: status, reason: reason ?? null })
    .onConflictDoUpdate({
      target: [schema.teacherAvailability.teacherId, schema.teacherAvailability.weekId],
      set: { availabilityStatus: status, reason: reason ?? null },
    });
}

function seatsByType(rows: Awaited<ReturnType<typeof listMagtuturoForWeek>>, type: "SUGO" | "RESERBA") {
  return rows
    .filter((r) => r.magType === type)
    .sort((a, b) => a.seat - b.seat)
    .map((r) => r.teacherCode);
}

describe("Magtuturo × Guro Duty", () => {
  let adminId: string;

  beforeEach(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
  });

  afterAll(async () => {
    await teardown();
  });

  it("eligible Katuwang fill the seats first, round-robin across dako rosters", async () => {
    const dakoA = await mkDako("GM-A1");
    const dakoB = await mkDako("GM-B1");
    // Two dako rosters of 4 Katuwang each.
    const a = [];
    for (const code of ["GK-A1", "GK-A2", "GK-A3", "GK-A4"]) {
      a.push(await mkTeacher(code, { duty: "KATUWANG", currentDestinationId: dakoA.id }));
    }
    const b = [];
    for (const code of ["GK-B1", "GK-B2", "GK-B3", "GK-B4"]) {
      b.push(await mkTeacher(code, { duty: "KATUWANG", currentDestinationId: dakoB.id }));
    }
    const dest = await mkTeacher("GD-D1", { duty: "DESTINADO", currentDestinationId: dakoA.id });
    const plain = await mkTeacher("GP-001");
    const w = await mkWeek(2091, 2);
    for (const t of [...a, ...b, dest, plain]) await setAvail(t.id, w.id, "AVAILABLE");

    const res = await generateMagtuturoWeek(w.id, { userId: adminId });
    expect(res.created).toBe(6);
    expect(res.detail.join(" ")).toContain("8 eligible Katuwang from 2 dako(s)");

    const rows = await listMagtuturoForWeek(w.id);
    // Round-robin across rosters: A1,B1,A2,B2 → SUGO 1-4; A3,B3 → RESERBA 1-2.
    expect(seatsByType(rows, "SUGO")).toEqual(["GK-A1", "GK-B1", "GK-A2", "GK-B2"]);
    expect(seatsByType(rows, "RESERBA")).toEqual(["GK-A3", "GK-B3"]);
    // Non-Katuwang and the 4th-of-each-roster Katuwang wait their turn.
    const codes = rows.map((r) => r.teacherCode);
    expect(codes).not.toContain("GD-D1");
    expect(codes).not.toContain("GP-001");
    expect(codes).not.toContain("GK-A4");
    expect(codes).not.toContain("GK-B4");

    // The audit trail records the duty-based split (candidate pools).
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "MAGTUTURO_GENERATED"));
    expect(logs[0]!.newValue).toMatchObject({ sugo: 4, reserba: 2, katuwang: 8, fallback: 2 });
  });

  it("rotation is fair per dako: the left-out Katuwang serve the next week", async () => {
    const dakoA = await mkDako("GM-A1");
    const dakoB = await mkDako("GM-B1");
    const w1 = await mkWeek(2091, 2);
    const w2 = await mkWeek(2091, 3);
    for (const code of ["GK-A1", "GK-A2", "GK-A3", "GK-A4", "GK-B1", "GK-B2", "GK-B3", "GK-B4"]) {
      const t = await mkTeacher(code, {
        duty: "KATUWANG",
        currentDestinationId: code.includes("-A") ? dakoA.id : dakoB.id,
      });
      await setAvail(t.id, w1.id, "AVAILABLE");
      await setAvail(t.id, w2.id, "AVAILABLE");
    }

    await generateMagtuturoWeek(w1.id, { userId: adminId });
    const week2 = await generateMagtuturoWeek(w2.id, { userId: adminId });
    expect(week2.created).toBe(6);
    expect(week2.detail.join(" ")).toContain("21.5"); // promotion still fires

    // Week 2: GK-A4 / GK-B4 (never served) rotate IN — the fairness proof.
    const codes = (await listMagtuturoForWeek(w2.id)).map((r) => r.teacherCode);
    expect(codes).toContain("GK-A4");
    expect(codes).toContain("GK-B4");
    // Week 1's RESERBA holders (A3/B3) are promoted by 21.5 (beats rotation),
    // so week 1's second-seed Katuwang (A2/B2) rest this week.
    expect(codes).toContain("GK-A3");
    expect(codes).toContain("GK-B3");
    expect(codes).not.toContain("GK-A2");
    expect(codes).not.toContain("GK-B2");
  });

  it("legacy universe (no duty recorded) behaves exactly as before", async () => {
    const plain = [];
    for (let i = 1; i <= 8; i++) plain.push(await mkTeacher(`GP-00${i}`));
    const w = await mkWeek(2091, 2);
    for (const t of plain) await setAvail(t.id, w.id, "AVAILABLE");
    const res = await generateMagtuturoWeek(w.id, { userId: adminId });
    expect(res.created).toBe(6); // unchanged behavior
    expect(res.detail.join(" ")).not.toContain("Duty roster");
  });

  it("partial roster: Katuwang lead the pool, uncovered seats fall back", async () => {
    const dakoA = await mkDako("GM-A1");
    const plain = [];
    for (let i = 1; i <= 4; i++) plain.push(await mkTeacher(`GP-00${i}`));
    const k1 = await mkTeacher("GK-A1", { duty: "KATUWANG", currentDestinationId: dakoA.id });
    const k2 = await mkTeacher("GK-A2", { duty: "KATUWANG", currentDestinationId: dakoA.id });
    const w = await mkWeek(2091, 2); // no prior week → no continuity in play
    for (const t of [...plain, k1, k2]) await setAvail(t.id, w.id, "AVAILABLE");
    const res = await generateMagtuturoWeek(w.id, { userId: adminId });
    expect(res.created).toBe(6);
    const rows = await listMagtuturoForWeek(w.id);
    // The two Katuwang hold the first SUGO seats; the other seats fall back.
    expect(seatsByType(rows, "SUGO").slice(0, 2).sort()).toEqual(["GK-A1", "GK-A2"]);
    expect(rows.filter((r) => r.teacherCode.startsWith("GK-")).length).toBe(2);
  });

  it("continuity (21.4/21.5) still beats the duty rotation", async () => {
    const dakoA = await mkDako("GM-A1");
    const carried = await mkTeacher("GC-001"); // absent SUGO → carries over (21.4)
    const promoted = await mkTeacher("GC-002"); // non-absent RESERBA → SUGO (21.5)
    const k1 = await mkTeacher("GK-A1", { duty: "KATUWANG", currentDestinationId: dakoA.id });
    const k2 = await mkTeacher("GK-A2", { duty: "KATUWANG", currentDestinationId: dakoA.id });
    const w1 = await mkWeek(2091, 2);
    const w2 = await mkWeek(2091, 3);
    await db.insert(schema.magtuturoAssignments).values([
      { weekId: w1.id, teacherId: carried.id, magType: "SUGO", seat: 1, assignmentSource: "MANUAL" },
      { weekId: w1.id, teacherId: promoted.id, magType: "RESERBA", seat: 1, assignmentSource: "MANUAL" },
    ]);
    await setAvail(carried.id, w2.id, "ABSENT", "travel"); // 21.3: still eligible
    await setAvail(promoted.id, w2.id, "AVAILABLE");
    await setAvail(k1.id, w2.id, "AVAILABLE");
    await setAvail(k2.id, w2.id, "AVAILABLE");

    const res = await generateMagtuturoWeek(w2.id, { userId: adminId });
    expect(res.detail.join(" ")).toContain("21.4");
    expect(res.detail.join(" ")).toContain("21.5");
    const sugo = seatsByType(await listMagtuturoForWeek(w2.id), "SUGO");
    expect(sugo.slice(0, 2)).toEqual(["GC-001", "GC-002"]); // continuity first
    expect(sugo.slice(2).sort()).toEqual(["GK-A1", "GK-A2"]); // Katuwang fill on
  });

  it("hard rules outrank duty — an ineligible Katuwang is skipped safely", async () => {
    const dakoA = await mkDako("GM-A1");
    const bad = await mkTeacher("GK-A1", { duty: "KATUWANG", currentDestinationId: dakoA.id });
    const good = await mkTeacher("GK-A2", { duty: "KATUWANG", currentDestinationId: dakoA.id });
    const plain = await mkTeacher("GP-001");
    const w = await mkWeek(2091, 2);
    await setAvail(bad.id, w.id, "INACTIVE"); // 21.7 hard
    await setAvail(good.id, w.id, "AVAILABLE");
    await setAvail(plain.id, w.id, "AVAILABLE");

    const res = await generateMagtuturoWeek(w.id, { userId: adminId });
    expect(res.created).toBe(2);
    const codes = (await listMagtuturoForWeek(w.id)).map((r) => r.teacherCode);
    expect(codes).not.toContain("GK-A1");
    expect(codes[0]).toBe("GK-A2"); // the eligible Katuwang leads
  });

  it("manual assignment stays duty-agnostic (21.10 non-regression)", async () => {
    const dakoA = await mkDako("GM-A1");
    const dest = await mkTeacher("GD-D1", { duty: "DESTINADO", currentDestinationId: dakoA.id });
    const w = await mkWeek(2091, 2);
    await setAvail(dest.id, w.id, "AVAILABLE");
    const out = await assignMagtuturo({
      weekId: w.id,
      teacherId: dest.id,
      magType: "SUGO",
      seat: 1,
      user: { userId: adminId },
    });
    expect(out.ok).toBe(true);
    const rows = await listMagtuturoForWeek(w.id);
    expect(rows.find((r) => r.magType === "SUGO" && r.seat === 1)!.teacherCode).toBe("GD-D1");
  });
});
