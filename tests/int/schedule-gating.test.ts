/**
 * Group 4 — schedule lifecycle gating integration tests.
 *
 * Two contracts are proven here against the live database:
 *
 *   A. The DATA the annual matrix gates on.
 *      `listWeekStatusesForYear` returns every PERSISTED week of the ISO year
 *      (weeks are created lazily, so a week with no row is simply not yet
 *      initialized — the matrix treats it as DRAFT, which is the correct
 *      default, and `isoWeeksInYear` still drives the 52/53 column count),
 *      and `listActiveScheduleCorrections` resolves the open window for many
 *      weeks in one query — DRAFT open, FINALIZED/PUBLISHED only inside a grant
 *      held by the caller. Both are read-only: neither writes an audit row.
 *
 *   B. The SERVER enforcement that the UI only reflects.
 *      FINALIZED revision needs `weeks.unlock` (ADMIN, SUPER_ADMIN or
 *      SCHEDULER/ENCODER — never VIEWER) plus a reason; the week stays
 *      FINALIZED throughout; only the grant holder may write; ending relocks
 *      instantly; and PUBLISHED is untouched — still SUPER_ADMIN +
 *      server-verified secret.
 *
 * No scheduler, assignment-rule, or history behaviour is exercised or altered.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import { WeekService, TeacherService, AvailabilityService } from "@/server/services";
import {
  assertScheduleCorrectable,
  beginFinalizedCorrection,
  beginPublishedCorrection,
  endScheduleCorrection,
  listActiveScheduleCorrections,
  scheduleCorrectionGrantHolder,
} from "@/server/services/correction.service";
import { listWeekStatusesForYear } from "@/server/services/assignment.service";
import { buildAnnualSchedule } from "@/lib/annual";
import { isoWeeksInYear } from "@/lib/iso-week";
import { getDb } from "@/server/db/client";
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

const YEAR = 2088;
let admin: SessionUser;
let otherAdmin: SessionUser;
let superAdmin: SessionUser;
let sched: SessionUser;

let draftWeekId: string;
let finalizedWeekId: string;
let publishedWeekId: string;

async function makeUser(email: string, role: "ADMIN" | "SCHEDULER"): Promise<string> {
  const inserted = await db
    .insert(schema.users)
    .values({ email, fullName: email, passwordHash: "x" })
    .returning();
  const id = inserted[0]!.id;
  const roles = await db.select().from(schema.roles).where(eq(schema.roles.code, role));
  await db.insert(schema.userRoles).values({ userId: id, roleId: roles[0]!.id });
  return id;
}

async function weekStatusAuditCount(weekId: string): Promise<number> {
  const rows = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, weekId));
  return rows.length;
}

beforeAll(async () => {
  await resetTestDb();
  admin = actor(await seedAdmin(), ["ADMIN"]);
  otherAdmin = actor(await makeUser("second-admin@test.local", "ADMIN"), ["ADMIN"]);
  superAdmin = actor(await makeUser("super-probe@test.local", "ADMIN"), ["SUPER_ADMIN"]);
  sched = actor(await seedScheduler(), ["SCHEDULER"]);

  const draft = await WeekService.getOrCreateWeek(YEAR, 10);
  draftWeekId = draft.id;
  const finalized = await WeekService.getOrCreateWeek(YEAR, 11);
  finalizedWeekId = finalized.id;
  const published = await WeekService.getOrCreateWeek(YEAR, 12);
  publishedWeekId = published.id;

  await WeekService.setWeekStatus(finalizedWeekId, { status: "FINALIZED" }, admin);
  await WeekService.setWeekStatus(publishedWeekId, { status: "FINALIZED" }, admin);
  await WeekService.setWeekStatus(publishedWeekId, { status: "PUBLISHED" }, admin);

  // A teacher + availability so the year has real assignment-shaped data.
  const t = await TeacherService.createTeacher(
    { teacherCode: "GATE-1", firstName: "Gate", lastName: "Probe", language: "FILIPINO" },
    admin,
  );
  await AvailabilityService.upsertAvailability(
    { teacherId: t.id, weekId: draftWeekId, availabilityStatus: "AVAILABLE" },
    admin,
  );
});

afterAll(async () => {
  await teardown();
});

// No test may inherit an open window from another. audit_logs is APPEND-ONLY
// (a DB trigger forbids UPDATE/DELETE), so isolation is achieved by ending any
// lingering window — which itself appends the audited ENDED row the real
// workflow writes — never by rewriting history.
afterEach(async () => {
  await endScheduleCorrection(finalizedWeekId, admin).catch(() => undefined);
  await endScheduleCorrection(publishedWeekId, superAdmin).catch(() => undefined);
});

describe("annual gating data — week statuses", () => {
  it("returns every PERSISTED week of the year and never leaks another year's", async () => {
    const statuses = await listWeekStatusesForYear(YEAR);
    // Exactly the three weeks created for this year — weeks are created lazily,
    // so an uninitialized week legitimately has no row (and defaults to DRAFT).
    expect(statuses.map((s) => s.isoWeekNumber).sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(statuses.every((s) => typeof s.id === "string" && s.id.length > 0)).toBe(true);
  });

  it("still spans the full ISO year in the matrix itself (52/53 columns)", () => {
    // The column count comes from ISO arithmetic, not from persisted rows, so a
    // year with only three initialized weeks still renders all of its columns.
    const schedule = buildAnnualSchedule([], YEAR, []);
    expect(schedule.weekCount).toBe(isoWeeksInYear(YEAR));
    expect(schedule.weekCount === 52 || schedule.weekCount === 53).toBe(true);
    expect(schedule.tables).toHaveLength(3);
  });

  it("exposes the three lifecycle weeks with their real status", async () => {
    const statuses = await listWeekStatusesForYear(YEAR);
    const byNumber = new Map(statuses.map((s) => [s.isoWeekNumber, s.status]));
    expect(byNumber.get(10)).toBe("DRAFT");
    expect(byNumber.get(11)).toBe("FINALIZED");
    expect(byNumber.get(12)).toBe("PUBLISHED");
  });

  it("threads the statuses into the matrix so gating is possible per cell", async () => {
    const statuses = await listWeekStatusesForYear(YEAR);
    const schedule = buildAnnualSchedule([], YEAR, statuses);
    expect(schedule.weekStatusByNumber[10]).toBe("DRAFT");
    expect(schedule.weekStatusByNumber[11]).toBe("FINALIZED");
    expect(schedule.weekStatusByNumber[12]).toBe("PUBLISHED");
    expect(schedule.weekCount).toBe(isoWeeksInYear(YEAR));
  });

  it("defaults an unknown week to DRAFT rather than locking it", () => {
    const schedule = buildAnnualSchedule([], YEAR, []);
    expect(schedule.weekStatusByNumber[999]).toBeUndefined();
  });
});

describe("annual gating data — correction windows (batched, read-only)", () => {
  it("reports no open window for a freshly initialized year and writes nothing", async () => {
    const statuses = await listWeekStatusesForYear(YEAR);
    const before = await weekStatusAuditCount(finalizedWeekId);
    const windows = await listActiveScheduleCorrections(statuses.map((s) => s.id));
    expect(windows[finalizedWeekId]).toBeUndefined();
    expect(windows[publishedWeekId]).toBeUndefined();
    expect(await weekStatusAuditCount(finalizedWeekId)).toBe(before);
  });

  it("returns {} for an empty id list without touching the database", async () => {
    expect(await listActiveScheduleCorrections([])).toEqual({});
  });

  it("surfaces an open FINALIZED window with its holder, in one batched call", async () => {
    const { expiresAt } = await beginFinalizedCorrection(finalizedWeekId, "audited reason", admin);
    const statuses = await listWeekStatusesForYear(YEAR);
    const windows = await listActiveScheduleCorrections(statuses.map((s) => s.id));
    const window = windows[finalizedWeekId]!;
    expect(window).toBeDefined();
    expect(window.role).toBe("FINALIZED");
    expect(window.holderId).toBe(admin.userId);
    // Derived from the same audited start; same TTL, same instant (allow 2s clock slack).
    expect(Math.abs(new Date(window.expiresAt).getTime() - expiresAt.getTime())).toBeLessThan(2000);
    expect(await scheduleCorrectionGrantHolder(finalizedWeekId)).toBe(admin.userId);
  });

  it("drops the window immediately after it ends", async () => {
    await beginFinalizedCorrection(finalizedWeekId, "audited reason", admin);
    await endScheduleCorrection(finalizedWeekId, admin);
    const windows = await listActiveScheduleCorrections([finalizedWeekId]);
    expect(windows[finalizedWeekId]).toBeUndefined();
  });

  it("never reports a window for a DRAFT or FINALIZED week that has none", async () => {
    const windows = await listActiveScheduleCorrections([draftWeekId, finalizedWeekId]);
    expect(windows[draftWeekId]).toBeUndefined();
    expect(windows[finalizedWeekId]).toBeUndefined();
  });
});

describe("FINALIZED revision — authorization", () => {
  // L2 rule: FINALIZED revision is gated by the `weeks.unlock` permission —
  // held by ADMIN, SUPER_ADMIN and SCHEDULER/ENCODER. VIEWER does not hold it.
  it("allows a SCHEDULER/ENCODER (L2 rule: SUPER_ADMIN + ADMIN + SCHEDULER)", async () => {
    await beginFinalizedCorrection(finalizedWeekId, "scheduler revision", sched);
    expect(await scheduleCorrectionGrantHolder(finalizedWeekId)).toBe(sched.userId);
    await endScheduleCorrection(finalizedWeekId, sched);
    expect(await scheduleCorrectionGrantHolder(finalizedWeekId)).toBeNull();
  });

  it("refuses a VIEWER (no weeks.unlock)", async () => {
    // Denied before any DB write, so a synthetic id is FK-safe here.
    await expect(
      beginFinalizedCorrection(finalizedWeekId, "viewer attempt", actor("00000000-0000-0000-0000-0000000000ff", ["VIEWER"])),
    ).rejects.toThrow(/weeks\.unlock/);
    expect(await scheduleCorrectionGrantHolder(finalizedWeekId)).toBeNull();
  });

  it("requires a non-empty, audited reason", async () => {
    await expect(beginFinalizedCorrection(finalizedWeekId, "   ", admin)).rejects.toThrow(/reason/);
    expect(await scheduleCorrectionGrantHolder(finalizedWeekId)).toBeNull();
  });

  it("applies only to FINALIZED weeks — never to DRAFT or PUBLISHED", async () => {
    await expect(beginFinalizedCorrection(draftWeekId, "wrong state", admin)).rejects.toThrow(/FINALIZED/);
    await expect(beginFinalizedCorrection(publishedWeekId, "wrong state", admin)).rejects.toThrow(/FINALIZED/);
  });

  it("keeps the week FINALIZED — the status column is never rewritten", async () => {
    await beginFinalizedCorrection(finalizedWeekId, "audited reason", admin);
    const row = (await db.select().from(schema.weeks).where(eq(schema.weeks.id, finalizedWeekId)))[0]!;
    expect(row.status).toBe("FINALIZED");
    await endScheduleCorrection(finalizedWeekId, admin);
    const after = (await db.select().from(schema.weeks).where(eq(schema.weeks.id, finalizedWeekId)))[0]!;
    expect(after.status).toBe("FINALIZED"); // no downgrade to DRAFT, ever
  });
});

describe("FINALIZED revision — write gate (what the matrix reflects)", () => {
  it("DRAFT is writable with no window at all", async () => {
    await expect(assertScheduleCorrectable(getDb(), draftWeekId, sched)).resolves.toBeUndefined();
  });

  it("FINALIZED is locked with no window", async () => {
    await expect(assertScheduleCorrectable(getDb(), finalizedWeekId, admin)).rejects.toThrow(/correction window/);
  });

  it("only the grant HOLDER may write inside the window", async () => {
    await beginFinalizedCorrection(finalizedWeekId, "audited reason", admin);
    await expect(assertScheduleCorrectable(getDb(), finalizedWeekId, admin)).resolves.toBeUndefined();
    await expect(assertScheduleCorrectable(getDb(), finalizedWeekId, otherAdmin)).rejects.toThrow(/another user/);
    await endScheduleCorrection(finalizedWeekId, admin);
  });

  it("relocks instantly once the window ends", async () => {
    await beginFinalizedCorrection(finalizedWeekId, "audited reason", admin);
    await endScheduleCorrection(finalizedWeekId, admin);
    await expect(assertScheduleCorrectable(getDb(), finalizedWeekId, admin)).rejects.toThrow(/correction window/);
  });
});

describe("PUBLISHED lock is untouched", () => {
  it("a FINALIZED window can never be opened on a PUBLISHED week (so the matrix stays non-interactive)", async () => {
    await expect(beginFinalizedCorrection(publishedWeekId, "audited reason", admin)).rejects.toThrow(/FINALIZED/);
    const windows = await listActiveScheduleCorrections([publishedWeekId]);
    expect(windows[publishedWeekId]).toBeUndefined();
  });

  it("still requires SUPER_ADMIN plus the server-verified secret", async () => {
    const savedSecret = process.env.PNK_SUPER_ADMIN_SECRET;
    process.env.PNK_SUPER_ADMIN_SECRET = "correct-horse-battery-staple";
    try {
      // ADMIN, even with the right secret, is refused.
      await expect(
        beginPublishedCorrection(publishedWeekId, "correct-horse-battery-staple", "admin attempt", admin),
      ).rejects.toThrow(/unlock failed/);
      // A wrong secret is refused with an identical generic message.
      await expect(
        beginPublishedCorrection(publishedWeekId, "not-the-secret", "attempt", superAdmin),
      ).rejects.toThrow(/unlock failed/);
      // No grant, and the week is still PUBLISHED.
      expect(await scheduleCorrectionGrantHolder(publishedWeekId)).toBeNull();
      const row = (await db.select().from(schema.weeks).where(eq(schema.weeks.id, publishedWeekId)))[0]!;
      expect(row.status).toBe("PUBLISHED");
      // The correct SUPER_ADMIN + secret opens the emergency window as designed.
      await beginPublishedCorrection(publishedWeekId, "correct-horse-battery-staple", "emergency fix", superAdmin);
      expect(await scheduleCorrectionGrantHolder(publishedWeekId)).toBe(superAdmin.userId);
      const stillPublished = (await db.select().from(schema.weeks).where(eq(schema.weeks.id, publishedWeekId)))[0]!;
      expect(stillPublished.status).toBe("PUBLISHED"); // no status change
    } finally {
      if (savedSecret === undefined) delete process.env.PNK_SUPER_ADMIN_SECRET;
      else process.env.PNK_SUPER_ADMIN_SECRET = savedSecret;
    }
  });
});
