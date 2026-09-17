/**
 * Master Consolidated Plan — E-1/E-2 correction architecture tests.
 * Proves: FINALIZED authorized correction (ADMIN, mandatory reason, audited,
 * TTL, grant-holder enforcement, week status never changes, regeneration
 * stays DRAFT-only); PUBLISHED SUPER_ADMIN unlock (role + server-verified
 * secret + reason, generic failure with no enumeration, scoped to one week,
 * audited, week remains PUBLISHED); LANGUAGE_MISMATCH and DAKO_DISABLED
 * rejected DURING an open grant; next-week availability stays editable while
 * the current week is FINALIZED/PUBLISHED (Invariants 10/11).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/session";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db } from "./helpers";
import { withTransaction } from "@/server/db/client";
import {
  beginFinalizedCorrection,
  beginPublishedCorrection,
  endScheduleCorrection,
  assertScheduleCorrectable,
  isScheduleCorrectionActive,
} from "@/server/services/correction.service";
import { createAssignment } from "@/server/services/assignment.service";
import { generateSchedule } from "@/server/services/scheduling.service";

function actor(userId: string, roles: string[]): SessionUser {
  return { userId, email: "x@test.local", fullName: "X", mustChangePassword: false, roleCodes: roles, permissions: [] };
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

async function mkTeacher(code: string, language: string, status = "ACTIVE") {
  const rows = await db
    .insert(schema.teachers)
    .values({ teacherCode: code, firstName: "T", lastName: code, language, status })
    .returning();
  return rows[0]!;
}
async function mkDako(code: string, language: string, status = "ACTIVE") {
  const rows = await db
    .insert(schema.dako)
    .values({
      dakoCode: code,
      name: `Dako ${code}`,
      address: "Addr",
      dateEstablished: "2000-01-01",
      worshipDay: "SUNDAY",
      worshipTime: "09:00",
      language,
      status,
    })
    .returning();
  return rows[0]!;
}
async function mkWeek(year: number, week: number, status = "FINALIZED") {
  const start = weekStart(year, week);
  const endD = new Date(`${start}T00:00:00Z`);
  endD.setUTCDate(endD.getUTCDate() + 6);
  const rows = await db
    .insert(schema.weeks)
    .values({ year, isoWeekNumber: week, startDate: start, endDate: endD.toISOString().slice(0, 10), status })
    .returning();
  return rows[0]!;
}

describe("correction architecture — FINALIZED correction, SUPER_ADMIN PUBLISHED unlock", () => {
  let adminId: string;
  let schedId: string;
  let admin: SessionUser;
  let sched: SessionUser;
  let superAdmin: SessionUser;
  let filTeacher: Awaited<ReturnType<typeof mkTeacher>>;
  let enTeacher: Awaited<ReturnType<typeof mkTeacher>>;
  let enDako: Awaited<ReturnType<typeof mkDako>>;
  let filDako: Awaited<ReturnType<typeof mkDako>>;

  beforeAll(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
    schedId = await seedScheduler();
    admin = actor(adminId, ["ADMIN"]);
    sched = actor(schedId, ["SCHEDULER"]);
    superAdmin = actor(adminId, ["SUPER_ADMIN"]);
    filTeacher = await mkTeacher("PNK-G-9901", "FILIPINO");
    enTeacher = await mkTeacher("PNK-G-9902", "ENGLISH");
    enDako = await mkDako("ILGD-9901", "ENGLISH");
    filDako = await mkDako("ILGD-9902", "FILIPINO");
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(() => {
    delete process.env.PNK_SUPER_ADMIN_SECRET;
    process.env.PNK_SCHEDULE_CORRECTION_TTL_MS = "1800000";
  });

  const unlockAudits = (weekId: string) =>
    db
      .select()
      .from(schema.auditLogs)
      .where(
        and(eq(schema.auditLogs.entityId, weekId), eq(schema.auditLogs.action, "PUBLISHED_SCHEDULE_UNLOCKED")),
      );
  const finalizedAudits = (weekId: string) =>
    db
      .select()
      .from(schema.auditLogs)
      .where(
        and(eq(schema.auditLogs.entityId, weekId), eq(schema.auditLogs.action, "FINALIZED_SCHEDULE_UNLOCKED")),
      );

  // ------------------------------------------------- E-1 FINALIZED correction
  it("E-1: non-ADMIN actors cannot begin a FINALIZED correction", async () => {
    const week = await mkWeek(2095, 1);
    await expect(beginFinalizedCorrection(week.id, "fix", sched)).rejects.toThrow(/administrator/);
  });

  it("E-1: empty reason rejected; valid begin audited; week STAYS FINALIZED", async () => {
    const week = await mkWeek(2095, 2);
    await expect(beginFinalizedCorrection(week.id, "   ", admin)).rejects.toThrow(/reason/);
    const res = await beginFinalizedCorrection(week.id, "fix wrong assignment before publication", admin);
    expect(res.status).toBe("FINALIZED");
    expect(await isScheduleCorrectionActive(week.id)).toBe(true);
    expect(await finalizedAudits(week.id)).toHaveLength(1);
    const after = (await db.select().from(schema.weeks).where(eq(schema.weeks.id, week.id)))[0]!;
    expect(after.status).toBe("FINALIZED"); // status column untouched
  });

  it("E-1: concurrent second begin is rejected", async () => {
    const week = await mkWeek(2095, 3);
    await beginFinalizedCorrection(week.id, "fix", admin);
    await expect(beginFinalizedCorrection(week.id, "again", admin)).rejects.toThrow(/already active/);
  });

  it("E-1: with an open grant the holder writes assignments; non-holders cannot", async () => {
    const week = await mkWeek(2095, 4);
    await beginFinalizedCorrection(week.id, "authorized fix", admin);
    const created = await createAssignment(
      { weekId: week.id, dakoId: filDako.id, teacherId: filTeacher.id, assignmentType: "SUGO" },
      admin,
    );
    expect(created.assignment.assignmentSource).toBe("MANUAL");
    await expect(
      createAssignment(
        { weekId: week.id, dakoId: filDako.id, teacherId: enTeacher.id, assignmentType: "RESERBA" },
        sched,
      ),
    ).rejects.toThrow(/held by another user/);
  });

  it("E-1: no grant ⇒ writes rejected; generation stays DRAFT-only", async () => {
    const week = await mkWeek(2095, 5);
    await withTransaction(async (tx) => {
      await expect(assertScheduleCorrectable(tx, week.id, admin)).rejects.toThrow(/correction window/);
    });
    await expect(generateSchedule(week.id, admin)).rejects.toThrow(/DRAFT/);
  });

  it("E-1: end re-locks; TTL expiry auto-relocks", async () => {
    const week = await mkWeek(2095, 6);
    await beginFinalizedCorrection(week.id, "fix", admin);
    await endScheduleCorrection(week.id, admin);
    expect(await isScheduleCorrectionActive(week.id)).toBe(false);
    await withTransaction(async (tx) => {
      await expect(assertScheduleCorrectable(tx, week.id, admin)).rejects.toThrow(/correction window/);
    });
    await beginFinalizedCorrection(week.id, "fix again", admin);
    process.env.PNK_SCHEDULE_CORRECTION_TTL_MS = "0";
    expect(await isScheduleCorrectionActive(week.id)).toBe(false); // expired
    delete process.env.PNK_SCHEDULE_CORRECTION_TTL_MS;
    process.env.PNK_SCHEDULE_CORRECTION_TTL_MS = "1800000";
  });

  // ------------------------------------------------- E-2 PUBLISHED unlock
  it("E-2: generic failure for wrong role / missing env / wrong secret; no audit, no grant, still PUBLISHED", async () => {
    const week = await mkWeek(2096, 1, "PUBLISHED");
    process.env.PNK_SUPER_ADMIN_SECRET = "correct-horse";
    // ADMIN (not SUPER_ADMIN) — generic failure.
    await expect(beginPublishedCorrection(week.id, "correct-horse", "reason", admin)).rejects.toThrow(/unlock failed/);
    // SUPER_ADMIN but env unset — fail closed.
    delete process.env.PNK_SUPER_ADMIN_SECRET;
    await expect(beginPublishedCorrection(week.id, "correct-horse", "reason", superAdmin)).rejects.toThrow(
      /unlock failed/,
    );
    // SUPER_ADMIN + wrong secret — identical generic failure.
    process.env.PNK_SUPER_ADMIN_SECRET = "correct-horse";
    await expect(beginPublishedCorrection(week.id, "wrong", "reason", superAdmin)).rejects.toThrow(/unlock failed/);
    expect(await unlockAudits(week.id)).toHaveLength(0);
    expect(await isScheduleCorrectionActive(week.id)).toBe(false);
    const after = (await db.select().from(schema.weeks).where(eq(schema.weeks.id, week.id)))[0]!;
    expect(after.status).toBe("PUBLISHED");
  });

  it("E-2: SUPER_ADMIN + secret + reason unlocks ONE week; audited; week remains PUBLISHED", async () => {
    const week = await mkWeek(2096, 2, "PUBLISHED");
    process.env.PNK_SUPER_ADMIN_SECRET = "correct-horse";
    const res = await beginPublishedCorrection(week.id, "correct-horse", "emergency correction", superAdmin);
    expect(res.status).toBe("PUBLISHED");
    expect(await isScheduleCorrectionActive(week.id)).toBe(true);
    expect(await unlockAudits(week.id)).toHaveLength(1);
    const after = (await db.select().from(schema.weeks).where(eq(schema.weeks.id, week.id)))[0]!;
    expect(after.status).toBe("PUBLISHED");
    // Scoped: another PUBLISHED week is NOT unlocked (never global).
    const other = await mkWeek(2096, 3, "PUBLISHED");
    expect(await isScheduleCorrectionActive(other.id)).toBe(false);
  });

  it("E-2: LANGUAGE_MISMATCH rejected during an open PUBLISHED grant (even for SUPER_ADMIN)", async () => {
    const week = await mkWeek(2096, 4, "PUBLISHED");
    process.env.PNK_SUPER_ADMIN_SECRET = "correct-horse";
    await beginPublishedCorrection(week.id, "correct-horse", "emergency", superAdmin);
    await expect(
      createAssignment(
        { weekId: week.id, dakoId: enDako.id, teacherId: filTeacher.id, assignmentType: "SUGO" },
        superAdmin,
      ),
    ).rejects.toThrow(/not overridable|ENGLISH/i);
  });

  it("E-2: DAKO_DISABLED rejected during an open PUBLISHED grant", async () => {
    const week = await mkWeek(2096, 5, "PUBLISHED");
    process.env.PNK_SUPER_ADMIN_SECRET = "correct-horse";
    await beginPublishedCorrection(week.id, "correct-horse", "emergency", superAdmin);
    const disabled = await mkDako("ILGD-9903", "ENGLISH");
    // Phase 1 CHECK: a DISABLED dako must carry date_disabled + reason.
    await db
      .update(schema.dako)
      .set({ status: "DISABLED", dateDisabled: "2096-01-01", disableReason: "closed" })
      .where(eq(schema.dako.id, disabled.id));
    await expect(
      createAssignment(
        { weekId: week.id, dakoId: disabled.id, teacherId: enTeacher.id, assignmentType: "SUGO" },
        superAdmin,
      ),
    ).rejects.toThrow(/DISABLED/i);
  });

  it("E-2: empty reason rejected; end re-locks; PUBLISHED stays PUBLISHED throughout", async () => {
    const week = await mkWeek(2096, 6, "PUBLISHED");
    process.env.PNK_SUPER_ADMIN_SECRET = "correct-horse";
    await expect(beginPublishedCorrection(week.id, "correct-horse", "  ", superAdmin)).rejects.toThrow(/reason/);
    await beginPublishedCorrection(week.id, "correct-horse", "fix", superAdmin);
    await endScheduleCorrection(week.id, superAdmin);
    expect(await isScheduleCorrectionActive(week.id)).toBe(false);
    const after = (await db.select().from(schema.weeks).where(eq(schema.weeks.id, week.id)))[0]!;
    expect(after.status).toBe("PUBLISHED");
  });

  // --------------------------------------- Invariants 10/11 next-week editing
  it("Inv 10/11: W39 availability stays editable while W38 is FINALIZED and again while PUBLISHED", async () => {
    const w38 = await mkWeek(2097, 38, "FINALIZED");
    const w39 = await mkWeek(2097, 39, "DRAFT");
    const setAvail = async (status: string) => {
      await db
        .insert(schema.teacherAvailability)
        .values({ teacherId: filTeacher.id, weekId: w39.id, availabilityStatus: status, reason: "test" })
        .onConflictDoUpdate({
          target: [schema.teacherAvailability.teacherId, schema.teacherAvailability.weekId],
          set: { availabilityStatus: status, reason: "test" },
        });
    };
    await setAvail("AVAILABLE");
    // W38 finalized — W39 still editable.
    await setAvail("ABSENT");
    await db.update(schema.weeks).set({ status: "PUBLISHED" }).where(eq(schema.weeks.id, w38.id));
    // W38 published — W39 STILL editable (no cross-week lock).
    await setAvail("AVAILABLE");
    const row = (
      await db
        .select()
        .from(schema.teacherAvailability)
        .where(and(eq(schema.teacherAvailability.weekId, w39.id), eq(schema.teacherAvailability.teacherId, filTeacher.id)))
    )[0]!;
    expect(row.availabilityStatus).toBe("AVAILABLE");
  });
});
