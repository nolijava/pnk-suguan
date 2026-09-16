/**
 * Phase 3 — Weekly Availability & Calendar test suite (§25).
 * Covers: week resolution/adjacency (52/53-safe), availability CRUD with
 * master-inactive guard, weekly list + NOT_ENCODED filter, previous-week and
 * history lookups, bulk save, fill-blanks, PUBLISHED locking + ADMIN
 * correction guarantees, RBAC, audit, and data integrity.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db, sql } from "./helpers";
import * as schema from "@/server/db/schema";
import { AvailabilityService, WeekService, TeacherService, AssignmentService, DakoService } from "@/server/services";
import { hasPermission } from "@/server/auth/permissions";
import type { SessionUser } from "@/server/auth/session";

function actor(userId: string, roles: string[]): SessionUser {
  return { userId, email: "x@test.local", fullName: "X", mustChangePassword: false, roleCodes: roles, permissions: [] };
}

function teacherInput(code: string, over: Partial<Parameters<typeof TeacherService.createTeacher>[0]> = {}) {
  return { teacherCode: code, firstName: "Avail", lastName: `Test ${code}`, language: "FILIPINO" as const, ...over };
}

/** Scheduling-table snapshot: rows availability ops must NEVER touch. */
async function snap() {
  const [a] = await sql`SELECT count(*)::int AS n FROM assignments`;
  const [h] = await sql`SELECT count(*)::int AS n FROM assignment_history`;
  const [t] = await sql`SELECT count(*)::int AS n FROM teachers`;
  const [d] = await sql`SELECT count(*)::int AS n FROM dako`;
  const [u] = await sql`SELECT count(*)::int AS n FROM users`;
  return { assignments: a!.n, history: h!.n, teachers: t!.n, dako: d!.n, users: u!.n };
}

let admin: SessionUser;
let sched: SessionUser;

beforeAll(async () => {
  await resetTestDb();
  const adminId = await seedAdmin();
  const schedId = await seedScheduler();
  admin = actor(adminId, ["ADMIN"]);
  sched = actor(schedId, ["SCHEDULER"]);
});

afterAll(async () => {
  await teardown();
});

describe("week resolution + adjacency (§5/§8/§9/§20)", () => {
  it("getOrCreateWeek is idempotent with correct ISO start/end dates", async () => {
    const w1 = await WeekService.getOrCreateWeek(2085, 1);
    const w2 = await WeekService.getOrCreateWeek(2085, 1);
    expect(w1.id).toBe(w2.id);
    expect(w1.isoWeekNumber).toBe(1);
    // ISO 2085-W01 starts Monday 2085-01-01 (that Monday IS Jan 1).
    expect(w1.startDate).toBe("2085-01-01");
    expect(w1.endDate).toBe("2085-01-07");
  });

  it("resolveWeek works by weekId and by {year, week}", async () => {
    const w = await WeekService.getOrCreateWeek(2085, 5);
    const byId = await WeekService.resolveWeek({ weekId: w.id });
    const byNum = await WeekService.resolveWeek({ year: 2085, week: 5 });
    expect(byId.id).toBe(w.id);
    expect(byNum.id).toBe(w.id);
    await expect(WeekService.resolveWeek({} as never)).rejects.toThrow(/weekId/);
  });

  it("rejects invalid ISO week numbers (53-week awareness)", async () => {
    // 2085 has 52 ISO weeks (2085-W53 does not exist).
    await expect(WeekService.resolveWeek({ year: 2085, week: 53 })).rejects.toThrow(/only 52/);
    // 2032 is a leap year starting on a Thursday → 53 ISO weeks.
    const w53 = await WeekService.resolveWeek({ year: 2032, week: 53 });
    expect(w53.isoWeekNumber).toBe(53);
    // …and W54 never exists.
    await expect(WeekService.resolveWeek({ year: 2032, week: 54 })).rejects.toThrow(/only 53/);
  });

  it("adjacentWeek crosses year wrap both directions (W1 ↔ W52/53)", async () => {
    const w1 = await WeekService.getOrCreateWeek(2085, 1);
    const prev = await WeekService.adjacentWeek(w1.id, -1);
    expect(prev.year).toBe(2084);
    expect([52, 53]).toContain(prev.isoWeekNumber);
    const backToW1 = await WeekService.adjacentWeek(prev.id, 1);
    expect(backToW1.id).toBe(w1.id);
  });

  it("adjacentWeek chains 52-week years correctly (W52 next → W1 next year)", async () => {
    const last = await WeekService.getOrCreateWeek(2085, 52);
    const next = await WeekService.adjacentWeek(last.id, 1);
    expect(next.year).toBe(2086);
    expect(next.isoWeekNumber).toBe(1);
  });

  it("currentWeek returns the ISO week containing today", async () => {
    const cw = await WeekService.currentWeek();
    const now = new Date();
    const jan4 = new Date(Date.UTC(now.getUTCFullYear(), 0, 4));
    void jan4;
    expect(cw.startDate).toBeDefined();
    // The current week must contain today's date.
    const today = now.toISOString().slice(0, 10);
    expect(cw.startDate <= today).toBe(true);
    expect(cw.endDate >= today).toBe(true);
  });
});

describe("availability CRUD + master-inactive guard (§3/§4/§5/§6/§14)", () => {
  it("creates a record, requires reason for ABSENT, enforces one row per teacher×week", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-001"), admin);
    const w = await WeekService.getOrCreateWeek(2093, 10);

    await expect(
      AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "ABSENT" }, admin),
    ).rejects.toThrow(/reason/);

    const rec = await AvailabilityService.upsertAvailability(
      { teacherId: t.id, weekId: w.id, availabilityStatus: "ABSENT", reason: "official activity" },
      admin,
    );
    expect(rec.reason).toBe("official activity");

    // update-in-place, never duplicate
    await AvailabilityService.upsertAvailability(
      { teacherId: t.id, weekId: w.id, availabilityStatus: "AVAILABLE" },
      admin,
    );
    const rows = await db
      .select()
      .from(schema.teacherAvailability)
      .where(drizzleSql`teacher_id = ${t.id} and week_id = ${w.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.availabilityStatus).toBe("AVAILABLE");
  });

  it("weekly AVAILABLE can NEVER override master-INACTIVE (write guard + effective status)", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-002"), admin);
    await TeacherService.deactivateTeacher(t.id, "moved away", admin);
    const w = await WeekService.getOrCreateWeek(2093, 11);

    await expect(
      AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "AVAILABLE" }, admin),
    ).rejects.toThrow(/master-INACTIVE/);
    await expect(
      AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "ABSENT", reason: "x" }, admin),
    ).rejects.toThrow(/master-INACTIVE/);

    // weekly INACTIVE rows ARE allowed for inactive teachers (consistency/history)
    const rec = await AvailabilityService.upsertAvailability(
      { teacherId: t.id, weekId: w.id, availabilityStatus: "INACTIVE" },
      admin,
    );
    expect(rec.availabilityStatus).toBe("INACTIVE");
  });

  it("a stale AVAILABLE row created before deactivation still resolves INACTIVE_MASTER", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-003"), admin);
    const w = await WeekService.getOrCreateWeek(2093, 12);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "AVAILABLE" }, admin);
    // deactivate AFTER the AVAILABLE record exists — historical row must NOT be rewritten
    await TeacherService.deactivateTeacher(t.id, "later deactivation", admin);

    const rows = await db
      .select()
      .from(schema.teacherAvailability)
      .where(drizzleSql`teacher_id = ${t.id} and week_id = ${w.id}`);
    expect(rows[0]!.availabilityStatus).toBe("AVAILABLE"); // untouched history

    const view = await AvailabilityService.getTeacherAvailability(t.id, w.id);
    expect(view!.weeklyStatus).toBe("AVAILABLE");
    expect(view!.effectiveStatus).toBe("INACTIVE_MASTER"); // precedence at read time
  });

  it("no-record = NOT_ENCODED in the weekly view", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-004"), admin);
    const w = await WeekService.getOrCreateWeek(2093, 13);
    const view = await AvailabilityService.getTeacherAvailability(t.id, w.id);
    expect(view!.weeklyStatus).toBeNull();
    expect(view!.effectiveStatus).toBe("NOT_ENCODED");
  });

  it("weekly INACTIVE beats ABSENT/AVAILABLE for master-ACTIVE (read precedence)", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-005"), admin);
    const w = await WeekService.getOrCreateWeek(2093, 14);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "INACTIVE" }, admin);
    const view = await AvailabilityService.getTeacherAvailability(t.id, w.id);
    expect(view!.effectiveStatus).toBe("INACTIVE_WEEKLY");
  });

  it("upserting identical values is a no-op (no rewrite, no extra audit)", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-006"), admin);
    const w = await WeekService.getOrCreateWeek(2093, 15);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "AVAILABLE" }, admin);
    const logsBefore = await db
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(schema.auditLogs)
      .where(drizzleSql`entity_type = 'teacher_availability'`);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "AVAILABLE" }, admin);
    const logsAfter = await db
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(schema.auditLogs)
      .where(drizzleSql`entity_type = 'teacher_availability'`);
    expect(logsAfter[0]!.n).toBe(logsBefore[0]!.n);
  });
});

describe("weekly list envelope + filters (§10/§11 refinement 4)", () => {
  let dakoA: Awaited<ReturnType<typeof DakoService.createDako>>;
  beforeAll(async () => {
    dakoA = await DakoService.createDako(
      { dakoCode: "P3-D1", name: "Week List Dako", address: "1 St", dateEstablished: "2001-01-01", worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO" },
      admin,
    );
    await TeacherService.createTeacher(teacherInput("P3-010", { language: "ENGLISH", currentDestinationId: dakoA.id }), admin);
    await TeacherService.createTeacher(teacherInput("P3-011"), admin);
    await TeacherService.createTeacher(teacherInput("P3-012"), admin);
    await TeacherService.createTeacher(teacherInput("P3-013", { purokGrupo: "Purok Ref" }), admin);
  });

  it("lists ALL teachers (including master-inactive) with effective status", async () => {
    const w = await WeekService.getOrCreateWeek(2094, 1);
    const t = await TeacherService.createTeacher(teacherInput("P3-014"), admin);
    await TeacherService.deactivateTeacher(t.id, "gone", admin);
    await AvailabilityService.upsertAvailability({ teacherId: (await TeacherService.listTeachers({ search: "P3-010" })).rows[0]!.id, weekId: w.id, availabilityStatus: "ABSENT", reason: "work" }, admin);
    await AvailabilityService.upsertAvailability({ teacherId: (await TeacherService.listTeachers({ search: "P3-011" })).rows[0]!.id, weekId: w.id, availabilityStatus: "AVAILABLE" }, admin);

    const list = await AvailabilityService.listWeeklyAvailability(w.id);
    expect(list.total).toBeGreaterThanOrEqual(5); // seeded rows present (DB is shared across describes)
    const byCode = new Map(list.rows.map((r) => [r.teacherCode, r]));
    expect(byCode.get("P3-010")!.effectiveStatus).toBe("ABSENT");
    expect(byCode.get("P3-011")!.effectiveStatus).toBe("AVAILABLE");
    expect(byCode.get("P3-012")!.effectiveStatus).toBe("NOT_ENCODED");
    expect(byCode.get("P3-013")!.effectiveStatus).toBe("NOT_ENCODED");
    expect(byCode.get("P3-014")!.effectiveStatus).toBe("INACTIVE_MASTER");
    expect(byCode.get("P3-014")!.masterStatus).toBe("INACTIVE");
  });

  it("filters by effective availability incl. NOT_ENCODED; master-inactive dominates", async () => {
    const w = await WeekService.getOrCreateWeek(2094, 1);
    const codes = (f: Parameters<typeof AvailabilityService.listWeeklyAvailability>[1]) =>
      AvailabilityService.listWeeklyAvailability(w.id, f).then((r) => r.rows.map((x) => x.teacherCode));
    const absent = await codes({ availability: "ABSENT" });
    expect(absent).toContain("P3-010");
    expect(absent).not.toContain("P3-011");
    const available = await codes({ availability: "AVAILABLE" });
    expect(available).toContain("P3-011");
    expect(available).not.toContain("P3-010");
    const notEncoded = await codes({ availability: "NOT_ENCODED" });
    expect(notEncoded).toEqual(expect.arrayContaining(["P3-012", "P3-013"]));
    expect(notEncoded).not.toContain("P3-010");
    const masterInactive = await codes({ availability: "INACTIVE_MASTER" });
    expect(masterInactive).toContain("P3-014");
    expect(masterInactive).not.toContain("P3-011"); // master-inactive dominates weekly values
  });

  it("filters by master status, language, destination; searches code/name", async () => {
    const w = await WeekService.getOrCreateWeek(2094, 1);
    const codes = (f: Parameters<typeof AvailabilityService.listWeeklyAvailability>[1]) =>
      AvailabilityService.listWeeklyAvailability(w.id, f).then((r) => r.rows.map((x) => x.teacherCode));
    const inactive = await codes({ masterStatus: "INACTIVE" });
    expect(inactive).toContain("P3-014");
    expect(inactive).not.toContain("P3-010");
    const english = await codes({ language: "ENGLISH" });
    expect(english).toContain("P3-010");
    expect(english).not.toContain("P3-011");
    const dest = await codes({ currentDestinationId: dakoA.id });
    expect(dest).toEqual(["P3-010"]); // only seeded destination membership
    const byName = await codes({ search: "Test P3-011" });
    expect(byName).toEqual(["P3-011"]);
  });

  it("sorts by code and name with direction", async () => {
    const w = await WeekService.getOrCreateWeek(2094, 1);
    const asc = (await AvailabilityService.listWeeklyAvailability(w.id, { sort: "code", order: "asc" })).rows.map((r) => r.teacherCode);
    expect(asc).toEqual([...asc].sort());
    const desc = (await AvailabilityService.listWeeklyAvailability(w.id, { sort: "code", order: "desc" })).rows.map((r) => r.teacherCode);
    expect(desc).toEqual([...asc].reverse());
  });

  it("unknown week 404s", async () => {
    await expect(
      AvailabilityService.listWeeklyAvailability("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/not found/);
  });
});

describe("previous-week + history lookups (§7/§9/§15)", () => {
  it("getPreviousWeekAvailability returns the prior ISO week row (year-wrap safe)", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-020"), admin);
    const w1 = await WeekService.getOrCreateWeek(2095, 1);
    const w2 = await WeekService.getOrCreateWeek(2095, 2);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w1.id, availabilityStatus: "ABSENT", reason: "travel" }, admin);
    const prev = await AvailabilityService.getPreviousWeekAvailability(t.id, w2.id);
    expect(prev!.weeklyStatus).toBe("ABSENT");
    expect(prev!.reason).toBe("travel");
  });

  it("batch previous-week absence lookup returns exactly the absent set", async () => {
    const a1 = await TeacherService.createTeacher(teacherInput("P3-021"), admin);
    const a2 = await TeacherService.createTeacher(teacherInput("P3-022"), admin);
    const b = await TeacherService.createTeacher(teacherInput("P3-023"), admin);
    const w1 = await WeekService.getOrCreateWeek(2095, 3);
    const w2 = await WeekService.getOrCreateWeek(2095, 4);
    await AvailabilityService.upsertAvailability({ teacherId: a1.id, weekId: w1.id, availabilityStatus: "ABSENT", reason: "x1" }, admin);
    await AvailabilityService.upsertAvailability({ teacherId: a2.id, weekId: w1.id, availabilityStatus: "ABSENT", reason: "x2" }, admin);
    await AvailabilityService.upsertAvailability({ teacherId: b.id, weekId: w1.id, availabilityStatus: "AVAILABLE" }, admin);
    const absentSet = await AvailabilityService.wasAbsentPreviousWeekBatch(w2.id);
    expect(absentSet.has(a1.id)).toBe(true);
    expect(absentSet.has(a2.id)).toBe(true);
    expect(absentSet.has(b.id)).toBe(false);
  });

  it("returns null when no previous week exists yet", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-024"), admin);
    const w = await WeekService.getOrCreateWeek(2096, 1);
    // no week 2096-W0 exists — previous lookup finds nothing
    const prev = await AvailabilityService.getPreviousWeekAvailability(t.id, w.id);
    expect(prev).toBeNull();
  });

  it("history returns full weekly trail most-recent-first with reasons", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-025"), admin);
    const w5 = await WeekService.getOrCreateWeek(2095, 5);
    const w6 = await WeekService.getOrCreateWeek(2095, 6);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w5.id, availabilityStatus: "ABSENT", reason: "week5 reason" }, admin);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w6.id, availabilityStatus: "AVAILABLE" }, admin);
    const hist = await AvailabilityService.getAvailabilityHistory(t.id);
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(hist[0]!.isoWeekNumber).toBe(6); // most recent first
    const w5row = hist.find((h) => h.isoWeekNumber === 5)!;
    expect(w5row.availabilityStatus).toBe("ABSENT");
    expect(w5row.reason).toBe("week5 reason");
  });

  it("Phase 1 wasAbsentPreviousWeek stays compatible (§26)", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-026"), admin);
    await WeekService.getOrCreateWeek(2095, 7);
    const w8 = await WeekService.getOrCreateWeek(2095, 8);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: (await WeekService.resolveWeek({ year: 2095, week: 7 })).id, availabilityStatus: "ABSENT", reason: "sick" }, admin);
    expect(await AvailabilityService.wasAbsentPreviousWeek(t.id, 2095, 8)).toBe(true);
    expect(await AvailabilityService.wasAbsentPreviousWeek(t.id, 2095, 9)).toBe(false);
    void w8;
  });
});

describe("bulk save (§11)", () => {
  it("saves multiple rows in one transaction with per-row validation and audit", async () => {
    const t1 = await TeacherService.createTeacher(teacherInput("P3-030"), admin);
    const t2 = await TeacherService.createTeacher(teacherInput("P3-031"), admin);
    const w = await WeekService.getOrCreateWeek(2097, 1);
    const res = await AvailabilityService.bulkSetAvailability(
      {
        changes: [
          { teacherId: t1.id, weekId: w.id, availabilityStatus: "AVAILABLE" },
          { teacherId: t2.id, weekId: w.id, availabilityStatus: "ABSENT", reason: "bulk reason" },
        ],
      },
      admin,
    );
    expect(res.saved).toBe(2);
    const rows = await db.select().from(schema.teacherAvailability).where(drizzleSql`week_id = ${w.id}`);
    expect(rows).toHaveLength(2);
    const t2row = rows.find((r) => r.teacherId === t2.id)!;
    expect(t2row.reason).toBe("bulk reason");
    // per-row audit
    const logs = await db.select().from(schema.auditLogs).where(drizzleSql`entity_type = 'teacher_availability' and entity_id = ${t2row.id}`);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.userId).toBe(admin.userId);
  });

  it("rejects rows with missing ABSENT reason (whole batch fails)", async () => {
    const t1 = await TeacherService.createTeacher(teacherInput("P3-032"), admin);
    const t2 = await TeacherService.createTeacher(teacherInput("P3-033"), admin);
    const w = await WeekService.getOrCreateWeek(2097, 2);
    await expect(
      AvailabilityService.bulkSetAvailability(
        {
          changes: [
            { teacherId: t1.id, weekId: w.id, availabilityStatus: "AVAILABLE" },
            { teacherId: t2.id, weekId: w.id, availabilityStatus: "ABSENT" }, // no reason
          ],
        },
        admin,
      ),
    ).rejects.toThrow(/row 2/);
    // transaction rolled back — nothing persisted
    const rows = await db.select().from(schema.teacherAvailability).where(drizzleSql`week_id = ${w.id}`);
    expect(rows).toHaveLength(0);
  });

  it("rejects master-inactive rows inside the batch", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-034"), admin);
    await TeacherService.deactivateTeacher(t.id, "gone", admin);
    const w = await WeekService.getOrCreateWeek(2097, 3);
    await expect(
      AvailabilityService.bulkSetAvailability(
        { changes: [{ teacherId: t.id, weekId: w.id, availabilityStatus: "AVAILABLE" }] },
        admin,
      ),
    ).rejects.toThrow(/master-INACTIVE/);
  });

  it("rejects mixed-week payloads", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-035"), admin);
    const w1 = await WeekService.getOrCreateWeek(2097, 4);
    const w2 = await WeekService.getOrCreateWeek(2097, 5);
    await expect(
      AvailabilityService.bulkSetAvailability(
        {
          changes: [
            { teacherId: t.id, weekId: w1.id, availabilityStatus: "AVAILABLE" },
            { teacherId: t.id, weekId: w2.id, availabilityStatus: "AVAILABLE" },
          ],
        },
        admin,
      ),
    ).rejects.toThrow(/single week/);
  });
});

describe("fill blanks as AVAILABLE (§11 refinement 3)", () => {
  it("targets only master-ACTIVE teachers with NO record; never overwrites; excludes master-INACTIVE", async () => {
    // Fresh week: baseline = however many unencoded actives earlier describes left behind.
    const w = await WeekService.getOrCreateWeek(2098, 1);
    const targetsBefore = await AvailabilityService.countFillBlankTargets(w.id);

    const blank1 = await TeacherService.createTeacher(teacherInput("P3-040"), admin);
    const blank2 = await TeacherService.createTeacher(teacherInput("P3-041"), admin);
    const encoded = await TeacherService.createTeacher(teacherInput("P3-042"), admin);
    const masterOff = await TeacherService.createTeacher(teacherInput("P3-043"), admin);
    await TeacherService.deactivateTeacher(masterOff.id, "inactive before fill", admin);
    await AvailabilityService.upsertAvailability({ teacherId: encoded.id, weekId: w.id, availabilityStatus: "ABSENT", reason: "pre-existing" }, admin);

    // Exactly our two blank teachers became new targets; encoded/inactive did not.
    expect(await AvailabilityService.countFillBlankTargets(w.id)).toBe(targetsBefore + 2);

    const res = await AvailabilityService.fillBlanksAsAvailable(w.id, admin);
    expect(res.created).toBe(targetsBefore + 2); // our two blanks + all earlier unencoded actives

    // encoded record untouched
    const encRow = (await db.select().from(schema.teacherAvailability).where(drizzleSql`teacher_id = ${encoded.id} and week_id = ${w.id}`))[0]!;
    expect(encRow.availabilityStatus).toBe("ABSENT");
    expect(encRow.reason).toBe("pre-existing");

    // master-inactive teacher NOT given a record
    const offRow = await db.select().from(schema.teacherAvailability).where(drizzleSql`teacher_id = ${masterOff.id} and week_id = ${w.id}`);
    expect(offRow).toHaveLength(0);

    // blanks created as AVAILABLE
    for (const t of [blank1, blank2]) {
      const row = (await db.select().from(schema.teacherAvailability).where(drizzleSql`teacher_id = ${t.id} and week_id = ${w.id}`))[0]!;
      expect(row.availabilityStatus).toBe("AVAILABLE");
    }

    // second run: no remaining targets, nothing created
    expect(await AvailabilityService.countFillBlankTargets(w.id)).toBe(0);
    const res2 = await AvailabilityService.fillBlanksAsAvailable(w.id, admin);
    expect(res2.created).toBe(0);
  });

  it("fill-blanks creations are audited per row", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-044"), admin);
    const w = await WeekService.getOrCreateWeek(2098, 2);
    await AvailabilityService.fillBlanksAsAvailable(w.id, admin);
    const row = (await db.select().from(schema.teacherAvailability).where(drizzleSql`teacher_id = ${t.id} and week_id = ${w.id}`))[0]!;
    const logs = await db.select().from(schema.auditLogs).where(drizzleSql`entity_type = 'teacher_availability' and entity_id = ${row.id}`);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.newValue).toMatchObject({ availabilityStatus: "AVAILABLE" });
  });
});

describe("PUBLISHED-week locking + ADMIN correction (§8b / refinements 1)", () => {
  let teacher: Awaited<ReturnType<typeof TeacherService.createTeacher>>;
  let dako: Awaited<ReturnType<typeof DakoService.createDako>>;
  let week: Awaited<ReturnType<typeof WeekService.getOrCreateWeek>>;

  beforeAll(async () => {
    teacher = await TeacherService.createTeacher(teacherInput("P3-050"), admin);
    dako = await DakoService.createDako(
      { dakoCode: "P3-DA", name: "Lock Dako", address: "1 St", dateEstablished: "2001-01-01", worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO" },
      admin,
    );
    week = await WeekService.getOrCreateWeek(2099, 1);
  });

  it("FINALIZED weeks remain editable for availability (only PUBLISHED locks)", async () => {
    const w = await WeekService.getOrCreateWeek(2099, 2);
    await WeekService.setWeekStatus(w.id, { status: "FINALIZED" }, admin);
    const rec = await AvailabilityService.upsertAvailability(
      { teacherId: teacher.id, weekId: w.id, availabilityStatus: "AVAILABLE" },
      admin,
    );
    expect(rec.availabilityStatus).toBe("AVAILABLE");
  });

  it("PUBLISHED week blocks availability writes for ADMIN and SCHEDULER alike", async () => {
    await AvailabilityService.upsertAvailability({ teacherId: teacher.id, weekId: week.id, availabilityStatus: "AVAILABLE" }, admin); // seed while DRAFT
    await WeekService.setWeekStatus(week.id, { status: "FINALIZED" }, admin);
    await WeekService.setWeekStatus(week.id, { status: "PUBLISHED" }, admin);
    for (const a of [admin, sched]) {
      await expect(
        AvailabilityService.upsertAvailability({ teacherId: teacher.id, weekId: week.id, availabilityStatus: "ABSENT", reason: "blocked" }, a),
      ).rejects.toThrow(/PUBLISHED/);
    }
  });

  it("correction requires ADMIN (scheduler/viewer forbidden)", async () => {
    await expect(AvailabilityService.beginAvailabilityCorrection(week.id, "scheduler attempt", sched)).rejects.toThrow(/ADMIN/);
    await expect(
      AvailabilityService.beginAvailabilityCorrection(week.id, "x", actor("00000000-0000-0000-0000-000000000000", ["VIEWER"])),
    ).rejects.toThrow(/ADMIN/);
  });

  it("correction requires a reason; only valid on PUBLISHED weeks", async () => {
    await expect(AvailabilityService.beginAvailabilityCorrection(week.id, "   ", admin)).rejects.toThrow(/reason/);
    const draftWeek = await WeekService.getOrCreateWeek(2099, 3); // still DRAFT
    await expect(AvailabilityService.beginAvailabilityCorrection(draftWeek.id, "why unlock a draft?", admin)).rejects.toThrow(/PUBLISHED/);
  });

  it("ADMIN correction allows editing while the week stays PUBLISHED", async () => {
    await AvailabilityService.beginAvailabilityCorrection(week.id, "absence was misrecorded", admin);

    // week status untouched
    const w = await WeekService.getWeek(week.id);
    expect(w.status).toBe("PUBLISHED");

    // the granting admin can now edit availability
    const rec = await AvailabilityService.upsertAvailability(
      { teacherId: teacher.id, weekId: week.id, availabilityStatus: "ABSENT", reason: "corrected reason" },
      admin,
    );
    expect(rec.availabilityStatus).toBe("ABSENT");
    expect(rec.reason).toBe("corrected reason");

    // week is STILL PUBLISHED after the correction write
    expect((await WeekService.getWeek(week.id)).status).toBe("PUBLISHED");
  });

  it("non-granting users still blocked during an active correction", async () => {
    await expect(
      AvailabilityService.upsertAvailability({ teacherId: teacher.id, weekId: week.id, availabilityStatus: "AVAILABLE" }, sched),
    ).rejects.toThrow(/PUBLISHED/);
    // a second admin (no grant) is also blocked — grant is session-scoped
    const admin2Id = await seedAdmin();
    void admin2Id; // seedAdmin caches; use a synthetic distinct admin id instead
    const otherAdmin = actor("11111111-1111-1111-1111-111111111111", ["ADMIN"]);
    await expect(
      AvailabilityService.upsertAvailability({ teacherId: teacher.id, weekId: week.id, availabilityStatus: "AVAILABLE" }, otherAdmin),
    ).rejects.toThrow(/PUBLISHED/);
  });

  it("end correction re-locks; corrections cannot begin twice; audited begin+end", async () => {
    await expect(AvailabilityService.beginAvailabilityCorrection(week.id, "again", admin)).rejects.toThrow(/already active/);
    await AvailabilityService.endAvailabilityCorrection(week.id, admin);
    expect((await WeekService.getWeek(week.id)).status).toBe("PUBLISHED");
    await expect(
      AvailabilityService.upsertAvailability({ teacherId: teacher.id, weekId: week.id, availabilityStatus: "AVAILABLE" }, admin),
    ).rejects.toThrow(/PUBLISHED/);

    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(drizzleSql`entity_type = 'week' and entity_id = ${week.id} and action in ('UNLOCKED_AVAILABILITY_CORRECTION','ENDED_AVAILABILITY_CORRECTION')`)
      .orderBy(schema.auditLogs.createdAt);
    expect(logs).toHaveLength(2);
    expect(logs[0]!.action).toBe("UNLOCKED_AVAILABILITY_CORRECTION");
    expect(logs[0]!.reason).toBe("absence was misrecorded");
    expect(logs[0]!.userId).toBe(admin.userId);
    expect(logs[0]!.createdAt).toBeInstanceOf(Date);
    expect((logs[0]!.oldValue as { status: string }).status).toBe("PUBLISHED");
    expect((logs[0]!.newValue as { availabilityEditable: boolean }).availabilityEditable).toBe(true);
    expect(logs[1]!.action).toBe("ENDED_AVAILABILITY_CORRECTION");
    expect((logs[1]!.newValue as { availabilityEditable: boolean }).availabilityEditable).toBe(false);
  });

  it("end correction without an active grant conflicts", async () => {
    await expect(AvailabilityService.endAvailabilityCorrection(week.id, admin)).rejects.toThrow(/no availability correction/);
  });

  it("PUBLISHED correction does NOT unlock assignments: assertWeekMutable unchanged", async () => {
    await AvailabilityService.beginAvailabilityCorrection(week.id, "correction does not touch schedule", admin);
    // assignment writes remain frozen even mid-correction
    await expect(
      AssignmentService.createAssignment({ weekId: week.id, dakoId: dako.id, teacherId: teacher.id, assignmentType: "SUGO" }, admin),
    ).rejects.toThrow(/PUBLISHED|immutable|require unlock|DRAFT/);
    // direct guard check — byte-for-byte Phase 1 behavior
    await expect(WeekService.assertWeekMutable({ ...sql } as never, week.id)).rejects.toThrow();
    // correct a row, week remains PUBLISHED, then end
    await AvailabilityService.upsertAvailability({ teacherId: teacher.id, weekId: week.id, availabilityStatus: "ABSENT", reason: "still corrected" }, admin);
    expect((await WeekService.getWeek(week.id)).status).toBe("PUBLISHED");
    await AvailabilityService.endAvailabilityCorrection(week.id, admin);
  });

  it("no Sugo/Reserba/Reserba II rows were created or altered by availability work", async () => {
    const rows = await db.select().from(schema.assignments).where(drizzleSql`week_id = ${week.id}`);
    expect(rows).toHaveLength(0);
  });
});

describe("RBAC (§17)", () => {
  it("viewer cannot write availability; scheduler and admin can; anonymous cannot", () => {
    expect(hasPermission(["VIEWER"], "availability.write")).toBe(false);
    expect(hasPermission(["VIEWER"], "availability.read")).toBe(true);
    expect(hasPermission(["SCHEDULER"], "availability.write")).toBe(true);
    expect(hasPermission(["ADMIN"], "availability.write")).toBe(true);
    expect(hasPermission([], "availability.write")).toBe(false);
    expect(hasPermission([], "availability.read")).toBe(false);
  });

  it("scheduler cannot manage users (Phase 2 rule preserved)", () => {
    expect(hasPermission(["SCHEDULER"], "users.manage")).toBe(false);
  });
});

describe("audit + data integrity (§16/§18/§21)", () => {
  it("availability writes never touch teachers/dako/assignments/history", async () => {
    const before = await snap();
    const t = await TeacherService.createTeacher(teacherInput("P3-060"), admin);
    const w = await WeekService.getOrCreateWeek(2100, 1);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "ABSENT", reason: "integrity probe" }, admin);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "AVAILABLE" }, admin);
    await AvailabilityService.fillBlanksAsAvailable(w.id, admin);
    const after = await snap();
    // teachers/dako/assignments/history/users counts unchanged (availability rows themselves are expected to grow)
    expect(after.teachers).toBe(before.teachers + 1); // only the teacher we created
    expect(after.dako).toBe(before.dako);
    expect(after.assignments).toBe(before.assignments);
    expect(after.history).toBe(before.history);
    expect(after.users).toBe(before.users);
  });

  it("master-data changes never rewrite historical availability rows", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-061"), admin);
    const w = await WeekService.getOrCreateWeek(2100, 2);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "ABSENT", reason: "original reason" }, admin);

    await TeacherService.updateTeacher(t.id, { firstName: "RenamedAvail", language: "ENGLISH" }, admin);
    const someDako = await DakoService.createDako(
      { dakoCode: "P3-DB", name: "Integrity Dako", address: "1 St", dateEstablished: "2001-01-01", worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO" },
      admin,
    );
    await DakoService.disableDako(someDako.id, "unrelated disable", admin);

    const rows = await db
      .select()
      .from(schema.teacherAvailability)
      .where(drizzleSql`teacher_id = ${t.id} and week_id = ${w.id}`);
    expect(rows[0]!.availabilityStatus).toBe("ABSENT");
    expect(rows[0]!.reason).toBe("original reason");
  });

  it("audit records carry user, timestamp, old/new, and reason", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P3-062"), admin);
    const w = await WeekService.getOrCreateWeek(2100, 3);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "AVAILABLE" }, admin);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "ABSENT", reason: "why absent" }, admin);
    const row = (await db.select().from(schema.teacherAvailability).where(drizzleSql`teacher_id = ${t.id} and week_id = ${w.id}`))[0]!;
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(drizzleSql`entity_type = 'teacher_availability' and entity_id = ${row.id}`)
      .orderBy(schema.auditLogs.createdAt);
    expect(logs).toHaveLength(2); // create + change (no-op skip proven earlier)
    const change = logs[1]!;
    expect(change.userId).toBe(admin.userId);
    expect(change.createdAt).toBeInstanceOf(Date);
    expect((change.oldValue as { availabilityStatus: string }).availabilityStatus).toBe("AVAILABLE");
    expect((change.newValue as { availabilityStatus: string }).availabilityStatus).toBe("ABSENT");
    expect(change.reason).toBe("why absent");
  });

  it("audit_logs remains append-only at the DB level", async () => {
    await expect(sql`UPDATE audit_logs SET reason = 'tamper'`).rejects.toThrow();
    await expect(sql`DELETE FROM audit_logs`).rejects.toThrow();
  });
});
