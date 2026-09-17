/**
 * Master plan Group 6 — Historical Backfill workflow (§32–§34, §56).
 * Proves: pre-go-live weeks are record-only (generation rejected both ways),
 * HISTORICAL never mixes with normal-cycle rows, the language hard rule holds
 * for historical input, rows stay HISTORICAL through corrections, historical
 * rows COUNT toward fairness counts, master data is never touched, and RBAC
 * (write permission + ADMIN-only correction) is enforced server-side.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/session";
import type { Permission } from "@/server/auth/permissions";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db } from "./helpers";

function actor(userId: string, roles: string[], permissions: Permission[] = []): SessionUser {
  return {
    userId,
    email: "x@test.local",
    fullName: "X",
    mustChangePassword: false,
    roleCodes: roles,
    permissions,
  };
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

describe("master plan group 6 — historical backfill", () => {
  let adminId: string;
  let schedId: string;

  beforeEach(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
    schedId = await seedScheduler();
  });

  afterAll(async () => {
    await teardown();
  });

  // The service gate uses permissions on the caller — the write actor carries
  // assignments.write (matching what requirePermission resolves for real users).
  const admin = () => actor(adminId, ["ADMIN"], ["assignments.write" as Permission]);
  const sched = () => actor(schedId, ["SCHEDULER"], ["assignments.write" as Permission]);
  const schedNoPerm = () => actor(schedId, ["SCHEDULER"], []);

  async function mkTeacher(code: string, over: Partial<{ status: string; language: string }> = {}) {
    const rows = await db.insert(schema.teachers).values({
      teacherCode: code,
      firstName: "T",
      lastName: code,
      language: "FILIPINO",
      dateInactive: over.status === "INACTIVE" ? "2099-01-01" : null,
      ...over,
    }).returning();
    return rows[0]!;
  }
  async function mkDako(code: string, over: Partial<{ language: string; status: string }> = {}) {
    const rows = await db.insert(schema.dako).values({
      dakoCode: code,
      name: `Dako ${code}`,
      address: "Addr",
      dateEstablished: "2000-01-01",
      worshipDay: "SUNDAY",
      worshipTime: "09:00",
      language: "FILIPINO",
      ...over,
    }).returning();
    return rows[0]!;
  }
  async function mkWeek(year: number, week: number, status = "PUBLISHED") {
    const start = weekStart(year, week);
    const endD = new Date(`${start}T00:00:00Z`);
    endD.setUTCDate(endD.getUTCDate() + 6);
    const rows = await db.insert(schema.weeks).values({
      year,
      isoWeekNumber: week,
      startDate: start,
      endDate: endD.toISOString().slice(0, 10),
      status,
    }).returning();
    return rows[0]!;
  }

  async function svc() {
    return import("@/server/services/historical.service");
  }

  it("records actual rows for a pre-go-live week with source HISTORICAL, audited, master data untouched", async () => {
    const t1 = await mkTeacher("H1-1");
    const d = await mkDako("HD-1");
    const w = await mkWeek(2026, 10); // before W38 go-live

    const h = await svc();
    const out = await h.recordHistoricalAssignments(
      w.id,
      [{ dakoId: d.id, teacherId: t1.id, assignmentType: "SUGO" }],
      admin(),
    );
    expect(out.recorded).toHaveLength(1);
    expect(out.recorded[0]!.assignmentSource).toBe("HISTORICAL");

    const rows = await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id));
    expect(rows[0]!.assignmentSource).toBe("HISTORICAL");
    expect(rows[0]!.status).toBe("ASSIGNED");

    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "HISTORICAL_BACKFILL_RECORDED"));
    expect(audits).toHaveLength(1);

    // Master data untouched (Invariant 4).
    const tAfter = await db.select().from(schema.teachers).where(eq(schema.teachers.id, t1.id));
    expect(tAfter[0]!.status).toBe("ACTIVE");
    expect(tAfter[0]!.currentDestinationId).toBeNull();
  });

  it("rejects recording for a go-live-or-later week (workflow separation, server-side)", async () => {
    const t = await mkTeacher("H2-1");
    const d = await mkDako("HD-2");
    const w = await mkWeek(2026, 38); // go-live week

    const h = await svc();
    await expect(
      h.recordHistoricalAssignments(w.id, [{ dakoId: d.id, teacherId: t.id, assignmentType: "SUGO" }], admin()),
    ).rejects.toThrow(/go-live/);
  });

  it("rejects generation for a pre-go-live week and recording of a mixed week (mutual exclusion)", async () => {
    const t = await mkTeacher("H3-1", { language: "ENGLISH" });
    const d = await mkDako("HD-3", { language: "ENGLISH" });
    const preW = await mkWeek(2026, 5);

    // Generate on a historical week → HistoricalWeekError.
    const { SchedulingService } = await import("@/server/services");
    await expect(SchedulingService.generateSchedule(preW.id, admin())).rejects.toThrow(/go-live/);

    // A normal-cycle row poisons a PRE-GO-LIVE week for backfill.
    const normalW = await mkWeek(2026, 10, "DRAFT");
    await db.insert(schema.assignments).values({
      weekId: normalW.id,
      dakoId: d.id,
      teacherId: t.id,
      assignmentType: "SUGO",
      assignmentSource: "AUTO",
      status: "ASSIGNED",
    });
    const h = await svc();
    await expect(
      h.recordHistoricalAssignments(
        normalW.id,
        [{ dakoId: d.id, teacherId: t.id, assignmentType: "RESERBA" }],
        admin(),
      ),
    ).rejects.toThrow(/normal-cycle|mixed/i);
  });

  it("enforces the language hard rule on historical input (FIL teacher → EN dako rejected, never auto-corrected)", async () => {
    const tFil = await mkTeacher("H4-1");
    const dEn = await mkDako("HD-4", { language: "ENGLISH" });
    const w = await mkWeek(2026, 12);

    const h = await svc();
    await expect(
      h.recordHistoricalAssignments(
        w.id,
        [{ dakoId: dEn.id, teacherId: tFil.id, assignmentType: "SUGO" }],
        admin(),
      ),
    ).rejects.toThrow(/LANGUAGE_MISMATCH|non-overrideable/i);

    const rows = await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, w.id));
    expect(rows).toHaveLength(0);
    // Teacher language was NOT modified to accommodate the row.
    const tAfter = await db.select().from(schema.teachers).where(eq(schema.teachers.id, tFil.id));
    expect(tAfter[0]!.language).toBe("FILIPINO");
  });

  it("ADMIN correction keeps the source HISTORICAL, requires a reason, and is audited; SCHEDULER forbidden", async () => {
    const t1 = await mkTeacher("H5-1");
    const t2 = await mkTeacher("H5-2");
    const d = await mkDako("HD-5");
    const w = await mkWeek(2026, 14);

    const h = await svc();
    const rec = await h.recordHistoricalAssignments(
      w.id,
      [{ dakoId: d.id, teacherId: t1.id, assignmentType: "SUGO" }],
      admin(),
    );
    const rowId = rec.recorded[0]!.id;

    // Scheduler cannot correct.
    await expect(
      h.correctHistoricalAssignment({ assignmentId: rowId, teacherId: t2.id }, "sched attempt", sched()),
    ).rejects.toThrow(/administrator/i);

    // Empty reason rejected.
    await expect(
      h.correctHistoricalAssignment({ assignmentId: rowId, teacherId: t2.id }, "  ", admin()),
    ).rejects.toThrow(/reason/i);

    // ADMIN correction succeeds; source stays HISTORICAL.
    const updated = await h.correctHistoricalAssignment(
      { assignmentId: rowId, teacherId: t2.id },
      "encoded against the paper log after re-verification",
      admin(),
    );
    expect(updated.assignmentSource).toBe("HISTORICAL");
    expect(updated.teacherId).toBe(t2.id);

    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "HISTORICAL_CORRECTION"));
    expect(audits).toHaveLength(1);
  });

  it("historical rows count toward fairness counts (Invariant 5)", async () => {
    const t = await mkTeacher("H6-1");
    const d = await mkDako("HD-6");
    const w = await mkWeek(2026, 8);

    const h = await svc();
    await h.recordHistoricalAssignments(
      w.id,
      [{ dakoId: d.id, teacherId: t.id, assignmentType: "SUGO" }],
      admin(),
    );

    // The scheduling context counts ALL ASSIGNED rows (any source) for fairness.
    const { buildSchedulingContext } = await import("@/server/services/scheduling/buildContext");
    const laterW = await mkWeek(2026, 40);
    const ctx = await buildSchedulingContext(laterW.id);
    expect(ctx.counts.get(`${t.id}|${d.id}|SUGO`)?.total).toBe(1);
  });

  it("enforces RBAC on the recording path (missing write permission → forbidden)", async () => {
    const t = await mkTeacher("H7-1");
    const d = await mkDako("HD-7");
    const w = await mkWeek(2026, 20);

    const h = await svc();
    await expect(
      h.recordHistoricalAssignments(
        w.id,
        [{ dakoId: d.id, teacherId: t.id, assignmentType: "SUGO" }],
        schedNoPerm(),
      ),
    ).rejects.toThrow(/assignments\.write/);
  });
});
