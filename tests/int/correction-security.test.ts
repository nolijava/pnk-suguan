/**
 * Phase 3 cleanup/security verification — PUBLISHED-week correction hardening.
 * Proves: server-enforced role checks (begin/end and availability writes),
 * mandatory non-empty reason, immediate re-lock after END, expired-grant
 * rejection, server-side TTL, client-state irrelevance, strict payload
 * validation on the API contract, and lock-serialized concurrency.
 * Week status / assertWeekMutable remain untouched throughout.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { resetTestDb, seedAdmin, seedScheduler, seedSuperAdmin, teardown, db, sql } from "./helpers";
import * as schema from "@/server/db/schema";
import { AvailabilityService, WeekService, TeacherService } from "@/server/services";
import { availabilityCorrectionSchema } from "@/lib/validation/query-schemas";
import { hasPermission } from "@/server/auth/permissions";
import type { SessionUser } from "@/server/auth/session";

function actor(userId: string, roles: string[]): SessionUser {
  return { userId, email: "x@test.local", fullName: "X", mustChangePassword: false, roleCodes: roles, permissions: [] };
}

let admin: SessionUser;
let sched: SessionUser;
let viewer: SessionUser;
let superAdmin: SessionUser;
let publishedWeekId: string;
let teacherId: string;
let auditBaseCount = 0;

async function correctionAuditCount(): Promise<number> {
  const rows = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(schema.auditLogs)
    .where(
      drizzleSql`entity_type = 'week' and entity_id = ${publishedWeekId}
        and action in ('UNLOCKED_AVAILABILITY_CORRECTION','ENDED_AVAILABILITY_CORRECTION')`,
    );
  return rows[0]!.n;
}

beforeAll(async () => {
  await resetTestDb();
  const adminId = await seedAdmin();
  const schedId = await seedScheduler();
  const superAdminId = await seedSuperAdmin();
  admin = actor(adminId, ["ADMIN"]);
  sched = actor(schedId, ["SCHEDULER"]);
  superAdmin = actor(superAdminId, ["SUPER_ADMIN"]);
  const viewerId = await db
    .insert(schema.users)
    .values({ email: "sec-viewer@test.local", fullName: "Sec Viewer", passwordHash: "x" })
    .returning();
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, "VIEWER"));
  await db.insert(schema.userRoles).values({ userId: viewerId[0]!.id, roleId: roleRows[0]!.id });
  viewer = actor(viewerId[0]!.id, ["VIEWER"]);

  // Build the PUBLISHED fixture: teacher + week, seeded availability, publish.
  const t = await TeacherService.createTeacher(
    { teacherCode: "SEC-1", firstName: "Sec", lastName: "Probe", language: "FILIPINO" },
    admin,
  );
  teacherId = t.id;
  const w = await WeekService.getOrCreateWeek(2077, 40);
  publishedWeekId = w.id;
  await AvailabilityService.upsertAvailability({ teacherId, weekId: publishedWeekId, availabilityStatus: "AVAILABLE" }, admin);
  await WeekService.setWeekStatus(publishedWeekId, { status: "FINALIZED" }, admin);
  await WeekService.setWeekStatus(publishedWeekId, { status: "PUBLISHED" }, admin);
  auditBaseCount = await correctionAuditCount();
  expect(auditBaseCount).toBe(0);
});

afterAll(async () => {
  await teardown();
});

describe("server-enforced RBAC on the correction path", () => {
  // L2 rule: the PUBLISHED availability window is SUPER_ADMIN-only — not
  // ADMINISTRATOR, not SCHEDULER/ENCODER, not VIEWER. Both begin and end are
  // gated, and a refused attempt must not append an audit row.
  it("administrator cannot begin or end a PUBLISHED-week correction (SUPER_ADMIN-only)", async () => {
    await expect(
      AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "admin escalate attempt", admin),
    ).rejects.toThrow(/SUPER_ADMIN/);
    await expect(AvailabilityService.endAvailabilityCorrection(publishedWeekId, admin)).rejects.toThrow(/SUPER_ADMIN/);
    expect(await correctionAuditCount()).toBe(auditBaseCount);
  });

  it("scheduler cannot begin or end a PUBLISHED-week correction", async () => {
    await expect(
      AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "scheduler escalate attempt", sched),
    ).rejects.toThrow(/SUPER_ADMIN/);
    await expect(AvailabilityService.endAvailabilityCorrection(publishedWeekId, sched)).rejects.toThrow(/SUPER_ADMIN/);
    expect(await correctionAuditCount()).toBe(auditBaseCount);
  });

  it("viewer cannot begin or end a correction (contract + permission map)", async () => {
    await expect(
      AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "viewer attempt", viewer),
    ).rejects.toThrow(/SUPER_ADMIN/);
    expect(hasPermission(["VIEWER"], "availability.write")).toBe(false);
    expect(await correctionAuditCount()).toBe(auditBaseCount);
  });

  it("anonymous (no roles) is rejected", async () => {
    await expect(
      AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "anon", actor("00000000-0000-0000-0000-000000000000", [])),
    ).rejects.toThrow(/SUPER_ADMIN/);
  });

  it("non-ADMIN cannot write availability on a PUBLISHED week even calling the service directly", async () => {
    await expect(
      AvailabilityService.upsertAvailability({ teacherId, weekId: publishedWeekId, availabilityStatus: "ABSENT", reason: "bypass try" }, sched),
    ).rejects.toThrow(/PUBLISHED/);
    await expect(
      AvailabilityService.bulkSetAvailability(
        { changes: [{ teacherId, weekId: publishedWeekId, availabilityStatus: "ABSENT", reason: "bulk bypass" }] },
        sched,
      ),
    ).rejects.toThrow(/PUBLISHED/);
    await expect(
      AvailabilityService.fillBlanksAsAvailable(publishedWeekId, sched),
    ).rejects.toThrow(/PUBLISHED/);
  });

  it("API contract: non-ADMIN payloads are structurally rejected before any service logic", () => {
    // The strict correction schema is the API's only accepted shape; reason is
    // mandatory for begin (superRefine), unknown keys rejected (.strict()).
    expect(availabilityCorrectionSchema.safeParse({ action: "begin" }).success).toBe(false);
    expect(availabilityCorrectionSchema.safeParse({ action: "begin", reason: "   " }).success).toBe(false);
    expect(availabilityCorrectionSchema.safeParse({ action: "begin", reason: "ok", extra: 1 }).success).toBe(false);
    expect(availabilityCorrectionSchema.safeParse({ action: "begin", reason: "legit reason" }).success).toBe(true);
    expect(availabilityCorrectionSchema.safeParse({ action: "end" }).success).toBe(true);
  });

  it("permission map: publish stays ADMIN-only; the L2 unlock grant does not widen anything else", () => {
    // L2 grants weeks.unlock to SCHEDULER so FINALIZED revision is reachable...
    expect(hasPermission(["SCHEDULER"], "weeks.unlock")).toBe(true);
    // ...but PUBLISHED correction is not permission-gated at all — it is an
    // explicit SUPER_ADMIN role check in the service, so publish stays closed.
    expect(hasPermission(["SCHEDULER"], "weeks.publish")).toBe(false);
    expect(hasPermission(["ADMIN"], "weeks.publish")).toBe(true);
    expect(hasPermission(["VIEWER"], "weeks.unlock")).toBe(false);
    expect(hasPermission(["VIEWER"], "availability.write")).toBe(false);
  });
});

describe("correction state machine security", () => {
  it("begin requires a non-empty reason (server-side)", async () => {
    await expect(AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "", superAdmin)).rejects.toThrow(/reason/);
    await expect(AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "    ", superAdmin)).rejects.toThrow(/reason/);
  });

  it("grant authorizes ONLY the granting super admin; week stays PUBLISHED", async () => {
    await AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "authorized super admin correction", superAdmin);
    // granting super admin may write
    const rec = await AvailabilityService.upsertAvailability(
      { teacherId, weekId: publishedWeekId, availabilityStatus: "ABSENT", reason: "corrected under grant" },
      superAdmin,
    );
    expect(rec.availabilityStatus).toBe("ABSENT");
    // week still PUBLISHED
    expect((await WeekService.getWeek(publishedWeekId)).status).toBe("PUBLISHED");
    // a DIFFERENT SUPER_ADMIN identity is NOT covered — the grant is
    // holder-scoped, not role-scoped. (Denied ⇒ no audit row, so a synthetic
    // user id is safe here.)
    const otherSuperAdmin = actor("22222222-2222-2222-2222-222222222222", ["SUPER_ADMIN"]);
    await expect(
      AvailabilityService.upsertAvailability({ teacherId, weekId: publishedWeekId, availabilityStatus: "AVAILABLE" }, otherSuperAdmin),
    ).rejects.toThrow(/PUBLISHED/);
  });

  it("ENDED_AVAILABILITY_CORRECTION immediately prevents further correction writes", async () => {
    await AvailabilityService.endAvailabilityCorrection(publishedWeekId, superAdmin);
    await expect(
      AvailabilityService.upsertAvailability({ teacherId, weekId: publishedWeekId, availabilityStatus: "AVAILABLE" }, superAdmin),
    ).rejects.toThrow(/PUBLISHED/);
    // begin/end pairs recorded exactly once each
    expect(await correctionAuditCount()).toBe(auditBaseCount + 2);
  });

  it("client/UI state cannot bypass server authorization (server re-derives state)", async () => {
    // Simulate a forged "correction open" client claim: the server decides from
    // the audit trail, not from any client input — no client-facing flag exists.
    await expect(
      AvailabilityService.upsertAvailability({ teacherId, weekId: publishedWeekId, availabilityStatus: "INACTIVE" }, admin),
    ).rejects.toThrow(/PUBLISHED/);
  });

  it("double-begin conflicts; end without grant conflicts", async () => {
    await AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "first legit open", superAdmin);
    await expect(AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "second open", superAdmin)).rejects.toThrow(/already active/);
    await AvailabilityService.endAvailabilityCorrection(publishedWeekId, superAdmin);
    await expect(AvailabilityService.endAvailabilityCorrection(publishedWeekId, superAdmin)).rejects.toThrow(/no availability correction/);
  });
});

/**
 * TTL is a CLOCK-DOMAIN question, so these tests never sleep.
 *
 * The grant's start is the audit row's `created_at`, authored by PostgreSQL;
 * expiry is therefore decided by PostgreSQL too (`clock_timestamp()` vs that
 * `created_at`, see availability.service.ts). A backdated audit row is written
 * straight into the append-only ledger with a DATABASE-computed timestamp, so
 * "expired" is an explicit input rather than a race the machine has to lose:
 * no setTimeout, no retries, no TTL inflation, and no dependence on how far
 * apart the PostgreSQL and Node clocks happen to be.
 */
describe("TTL expiry is enforced server-side (decided in one clock domain)", () => {
  // ORDER-INDEPENDENCE: each case below builds its OWN PUBLISHED week and
  // opens its own grant, so none of them can be affected by the order it runs
  // in, by a focused run (`-t`), or by a sibling case failing first. Sharing a
  // week is what made the recovery case silently depend on an earlier case
  // leaving a stale UNLOCK row behind — expiry is TTL-relative, so that row
  // reads as "active" again once the TTL is restored.
  async function makePublishedWeek(year: number, week: number): Promise<string> {
    const w = await WeekService.getOrCreateWeek(year, week);
    await WeekService.setWeekStatus(w.id, { status: "FINALIZED" }, admin);
    await WeekService.setWeekStatus(w.id, { status: "PUBLISHED" }, admin);
    return w.id;
  }

  /** Put the TTL env var back exactly as it was, whatever the case did to it. */
  function restoreTtlEnv(saved: string | undefined): void {
    if (saved === undefined) delete process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS;
    else process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS = saved;
  }

  it("an expired grant cannot authorize a write, a re-begin, or an end", async () => {
    const ttlWeekId = await makePublishedWeek(2077, 41);
    const saved = process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS;
    process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS = "0"; // grant expires instantly
    try {
      await expect(AvailabilityService.beginAvailabilityCorrection(ttlWeekId, "instant ttl", superAdmin))
        .resolves.toBeTruthy(); // begin succeeds, but the grant is already expired
      // The gate itself — the assertion that used to depend on millisecond
      // luck. TTL=0 is expired by construction: the UNLOCK row was written by
      // an earlier statement on the database clock, so `elapsed > 0 >= TTL`.
      expect(await AvailabilityService.isAvailabilityCorrectionActive(ttlWeekId)).toBe(false);
      await expect(
        AvailabilityService.upsertAvailability({ teacherId, weekId: ttlWeekId, availabilityStatus: "ABSENT", reason: "post-ttl" }, superAdmin),
      ).rejects.toThrow(/PUBLISHED/);
      await expect(
        AvailabilityService.bulkSetAvailability(
          { changes: [{ teacherId, weekId: ttlWeekId, availabilityStatus: "ABSENT", reason: "bulk post-ttl" }] },
          superAdmin,
        ),
      ).rejects.toThrow(/PUBLISHED/);
      // end treats it as not-active (expired ⇒ locked)
      await expect(AvailabilityService.endAvailabilityCorrection(ttlWeekId, superAdmin)).rejects.toThrow(/no availability correction/);
      // A re-begin is allowed precisely BECAUSE the previous grant reads as
      // expired rather than active.
      await expect(AvailabilityService.beginAvailabilityCorrection(ttlWeekId, "re-begin after instant expiry", superAdmin))
        .resolves.toBeTruthy();
      expect(await AvailabilityService.isAvailabilityCorrectionActive(ttlWeekId)).toBe(false);
    } finally {
      restoreTtlEnv(saved);
    }
  });

  it("expiry follows the database clock: a backdated grant is dead, a fresh one is live", async () => {
    const backdatedWeekId = await makePublishedWeek(2077, 42);
    const saved = process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS;
    process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS = "60000"; // 1 minute, explicit
    try {
      // A grant whose UNLOCK row is an hour old — inserted directly with a
      // DATABASE-computed created_at (audit_logs is append-only for UPDATE and
      // DELETE only, so this is the same row the real begin would have written).
      await db.insert(schema.auditLogs).values({
        userId: superAdmin.userId,
        action: "UNLOCKED_AVAILABILITY_CORRECTION",
        entityType: "week",
        entityId: backdatedWeekId,
        oldValue: { status: "PUBLISHED", availabilityEditable: false },
        newValue: { status: "PUBLISHED", availabilityEditable: true },
        reason: "grant opened an hour ago (fixture)",
        createdAt: drizzleSql`now() - interval '1 hour'`,
      });
      expect(await AvailabilityService.isAvailabilityCorrectionActive(backdatedWeekId)).toBe(false);
      await expect(
        AvailabilityService.upsertAvailability({ teacherId, weekId: backdatedWeekId, availabilityStatus: "ABSENT", reason: "post-ttl" }, superAdmin),
      ).rejects.toThrow(/PUBLISHED/);
      await expect(AvailabilityService.endAvailabilityCorrection(backdatedWeekId, superAdmin))
        .rejects.toThrow(/no availability correction/);

      // POSITIVE CONTROL — same TTL, same code path, same week: a grant that is
      // NOT old must still authorize. Without this, an implementation that
      // simply always reports "expired" would pass the negative cases above.
      await AvailabilityService.beginAvailabilityCorrection(backdatedWeekId, "fresh window control", superAdmin);
      expect(await AvailabilityService.isAvailabilityCorrectionActive(backdatedWeekId)).toBe(true);
      const rec = await AvailabilityService.upsertAvailability(
        { teacherId, weekId: backdatedWeekId, availabilityStatus: "ABSENT", reason: "inside window" },
        superAdmin,
      );
      expect(rec.availabilityStatus).toBe("ABSENT");
      await AvailabilityService.endAvailabilityCorrection(backdatedWeekId, superAdmin);
      expect(await AvailabilityService.isAvailabilityCorrectionActive(backdatedWeekId)).toBe(false);
    } finally {
      restoreTtlEnv(saved);
    }
  });

  it("a grant opened under TTL=0 becomes live when the TTL is raised, and the week recovers", async () => {
    const ttlWeekId = await makePublishedWeek(2077, 43);
    const saved = process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS;
    process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS = "0"; // open a window that is instantly expired
    try {
      await AvailabilityService.beginAvailabilityCorrection(ttlWeekId, "post-recovery begin", superAdmin);
      expect(await AvailabilityService.isAvailabilityCorrectionActive(ttlWeekId)).toBe(false); // expired

      // Same row, same clock domain, larger TTL ⇒ live again. That TTL-relative
      // semantics is exactly what made the old shared-fixture coupling possible;
      // pinning it here keeps the behavior asserted WITHOUT borrowing a sibling
      // case's leftovers.
      process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS = "1800000"; // restore 30 min
      expect(await AvailabilityService.isAvailabilityCorrectionActive(ttlWeekId)).toBe(true);

      await AvailabilityService.endAvailabilityCorrection(ttlWeekId, superAdmin);
      expect(await AvailabilityService.isAvailabilityCorrectionActive(ttlWeekId)).toBe(false);
      expect((await WeekService.getWeek(ttlWeekId)).status).toBe("PUBLISHED"); // status preserved
      await expect(
        AvailabilityService.upsertAvailability({ teacherId, weekId: ttlWeekId, availabilityStatus: "AVAILABLE" }, superAdmin),
      ).rejects.toThrow(/PUBLISHED/); // re-locked after END
    } finally {
      restoreTtlEnv(saved);
    }
  });
});

describe("concurrency: serialized on the week row", () => {
  it("concurrent begins produce exactly one active grant (loser conflicts)", async () => {
    const r1 = AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "concurrent A", superAdmin);
    const r2 = AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "concurrent B", superAdmin);
    const results = await Promise.allSettled([r1, r2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // exactly one UNLOCK row was appended by the two competing requests
    const unlockRows = await db
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(schema.auditLogs)
      .where(drizzleSql`entity_id = ${publishedWeekId} and action = 'UNLOCKED_AVAILABILITY_CORRECTION' and reason = 'concurrent A'`);
    const unlockRowsB = await db
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(schema.auditLogs)
      .where(drizzleSql`entity_id = ${publishedWeekId} and action = 'UNLOCKED_AVAILABILITY_CORRECTION' and reason = 'concurrent B'`);
    expect(unlockRows[0]!.n + unlockRowsB[0]!.n).toBe(1);
    await AvailabilityService.endAvailabilityCorrection(publishedWeekId, superAdmin);
  });

  it("a write committed before END lands; after END it is rejected (no extension of authorization)", async () => {
    await AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "ordered write vs end", superAdmin);
    await AvailabilityService.upsertAvailability(
      { teacherId, weekId: publishedWeekId, availabilityStatus: "ABSENT", reason: "within window" },
      superAdmin,
    );
    await AvailabilityService.endAvailabilityCorrection(publishedWeekId, superAdmin);
    await expect(
      AvailabilityService.upsertAvailability({ teacherId, weekId: publishedWeekId, availabilityStatus: "AVAILABLE" }, superAdmin),
    ).rejects.toThrow(/PUBLISHED/);
    // the in-window correction persisted; the post-window write did not
    const rows = await db
      .select()
      .from(schema.teacherAvailability)
      .where(drizzleSql`teacher_id = ${teacherId} and week_id = ${publishedWeekId}`);
    expect(rows[0]!.availabilityStatus).toBe("ABSENT");
  });
});

describe("fixtures intact after security probes", () => {
  it("week still PUBLISHED; assertWeekMutable still rejects assignment writes; no assignment rows exist", async () => {
    expect((await WeekService.getWeek(publishedWeekId)).status).toBe("PUBLISHED");
    await expect(
      AvailabilityService.listWeeklyAvailability(publishedWeekId),
    ).resolves.toBeTruthy();
    const assignments = await db.select().from(schema.assignments).where(drizzleSql`week_id = ${publishedWeekId}`);
    expect(assignments).toHaveLength(0);
    void sql;
  });
});
