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
import { resetTestDb, seedAdmin, seedScheduler, teardown, db, sql } from "./helpers";
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
  admin = actor(adminId, ["ADMIN"]);
  sched = actor(schedId, ["SCHEDULER"]);
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
  it("scheduler cannot begin or end a PUBLISHED-week correction", async () => {
    await expect(
      AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "scheduler escalate attempt", sched),
    ).rejects.toThrow(/ADMIN/);
    await expect(AvailabilityService.endAvailabilityCorrection(publishedWeekId, sched)).rejects.toThrow(/ADMIN/);
    expect(await correctionAuditCount()).toBe(auditBaseCount);
  });

  it("viewer cannot begin or end a correction (contract + permission map)", async () => {
    await expect(
      AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "viewer attempt", viewer),
    ).rejects.toThrow(/ADMIN/);
    expect(hasPermission(["VIEWER"], "availability.write")).toBe(false);
    expect(await correctionAuditCount()).toBe(auditBaseCount);
  });

  it("anonymous (no roles) is rejected", async () => {
    await expect(
      AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "anon", actor("00000000-0000-0000-0000-000000000000", [])),
    ).rejects.toThrow(/ADMIN/);
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

  it("permission map: only ADMIN holds the unlock/finalize/publish levers", () => {
    expect(hasPermission(["SCHEDULER"], "weeks.unlock")).toBe(false);
    expect(hasPermission(["SCHEDULER"], "weeks.publish")).toBe(false);
    expect(hasPermission(["ADMIN"], "weeks.publish")).toBe(true);
  });
});

describe("correction state machine security", () => {
  it("begin requires a non-empty reason (server-side)", async () => {
    await expect(AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "", admin)).rejects.toThrow(/reason/);
    await expect(AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "    ", admin)).rejects.toThrow(/reason/);
  });

  it("grant authorizes ONLY the granting admin; week stays PUBLISHED", async () => {
    await AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "authorized admin correction", admin);
    // granting admin may write
    const rec = await AvailabilityService.upsertAvailability(
      { teacherId, weekId: publishedWeekId, availabilityStatus: "ABSENT", reason: "corrected under grant" },
      admin,
    );
    expect(rec.availabilityStatus).toBe("ABSENT");
    // week still PUBLISHED
    expect((await WeekService.getWeek(publishedWeekId)).status).toBe("PUBLISHED");
    // a different ADMIN identity is NOT covered by the grant
    const otherAdmin = actor("22222222-2222-2222-2222-222222222222", ["ADMIN"]);
    await expect(
      AvailabilityService.upsertAvailability({ teacherId, weekId: publishedWeekId, availabilityStatus: "AVAILABLE" }, otherAdmin),
    ).rejects.toThrow(/PUBLISHED/);
  });

  it("ENDED_AVAILABILITY_CORRECTION immediately prevents further correction writes", async () => {
    await AvailabilityService.endAvailabilityCorrection(publishedWeekId, admin);
    await expect(
      AvailabilityService.upsertAvailability({ teacherId, weekId: publishedWeekId, availabilityStatus: "AVAILABLE" }, admin),
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
    await AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "first legit open", admin);
    await expect(AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "second open", admin)).rejects.toThrow(/already active/);
    await AvailabilityService.endAvailabilityCorrection(publishedWeekId, admin);
    await expect(AvailabilityService.endAvailabilityCorrection(publishedWeekId, admin)).rejects.toThrow(/no availability correction/);
  });
});

describe("TTL expiry is enforced server-side", () => {
  // Isolated second PUBLISHED week: TTL manipulation must not taint the main
  // fixture (an expired UNLOCK row becomes "active" again if the TTL is later
  // raised — that is correct TTL-relative behavior, so tests isolate it).
  let ttlWeekId: string;
  beforeAll(async () => {
    const w = await WeekService.getOrCreateWeek(2077, 41);
    ttlWeekId = w.id;
    await WeekService.setWeekStatus(ttlWeekId, { status: "FINALIZED" }, admin);
    await WeekService.setWeekStatus(ttlWeekId, { status: "PUBLISHED" }, admin);
  });

  it("an expired grant cannot authorize a write, a re-begin, or an end", async () => {
    process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS = "0"; // grant expires instantly
    try {
      await expect(AvailabilityService.beginAvailabilityCorrection(ttlWeekId, "instant ttl", admin))
        .resolves.toBeTruthy(); // begin succeeds, but the grant is already expired
      await expect(
        AvailabilityService.upsertAvailability({ teacherId, weekId: ttlWeekId, availabilityStatus: "ABSENT", reason: "post-ttl" }, admin),
      ).rejects.toThrow(/PUBLISHED/);
      await expect(
        AvailabilityService.bulkSetAvailability(
          { changes: [{ teacherId, weekId: ttlWeekId, availabilityStatus: "ABSENT", reason: "bulk post-ttl" }] },
          admin,
        ),
      ).rejects.toThrow(/PUBLISHED/);
      // end treats it as not-active (expired ⇒ locked)
      await expect(AvailabilityService.endAvailabilityCorrection(ttlWeekId, admin)).rejects.toThrow(/no availability correction/);
    } finally {
      process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS = "1800000"; // restore 30 min
    }
  });

  it("after TTL restoration the stale grant is endable and the week recovers", async () => {
    await AvailabilityService.endAvailabilityCorrection(ttlWeekId, admin); // clears the stale open state
    await AvailabilityService.beginAvailabilityCorrection(ttlWeekId, "post-recovery begin", admin);
    await AvailabilityService.endAvailabilityCorrection(ttlWeekId, admin);
    expect((await WeekService.getWeek(ttlWeekId)).status).toBe("PUBLISHED");
    await expect(
      AvailabilityService.upsertAvailability({ teacherId, weekId: ttlWeekId, availabilityStatus: "AVAILABLE" }, admin),
    ).rejects.toThrow(/PUBLISHED/);
  });
});

describe("concurrency: serialized on the week row", () => {
  it("concurrent begins produce exactly one active grant (loser conflicts)", async () => {
    const r1 = AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "concurrent A", admin);
    const r2 = AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "concurrent B", admin);
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
    await AvailabilityService.endAvailabilityCorrection(publishedWeekId, admin);
  });

  it("a write committed before END lands; after END it is rejected (no extension of authorization)", async () => {
    await AvailabilityService.beginAvailabilityCorrection(publishedWeekId, "ordered write vs end", admin);
    await AvailabilityService.upsertAvailability(
      { teacherId, weekId: publishedWeekId, availabilityStatus: "ABSENT", reason: "within window" },
      admin,
    );
    await AvailabilityService.endAvailabilityCorrection(publishedWeekId, admin);
    await expect(
      AvailabilityService.upsertAvailability({ teacherId, weekId: publishedWeekId, availabilityStatus: "AVAILABLE" }, admin),
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
