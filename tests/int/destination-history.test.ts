/**
 * Master Consolidated Plan E-3 — Destination History tests.
 * Proves: transactional close-previous/create-new on destination change; one
 * active period per teacher AND per dako (DB partial unique indexes); no
 * overlapping periods; history survives teacher INACTIVE and dako DISABLED;
 * weekly assignment operations create ZERO destination-history rows
 * (Invariant 3); Current-Destination clear closes (never deletes) the active
 * period; both list views read the same normalized table; full audit trail.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/session";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db } from "./helpers";
import {
  assignDestination,
  correctPeriod,
  closeActiveDestination,
  listForTeacher,
  listForDako,
} from "@/server/services/destination-history.service";
import { createAssignment, clearAssignment } from "@/server/services/assignment.service";

function actor(userId: string, roles: string[]): SessionUser {
  return { userId, email: "x@test.local", fullName: "X", mustChangePassword: false, roleCodes: roles, permissions: [] };
}

describe("E-3 — destination history (transactional, unique, preserved)", () => {
  let adminId: string;
  let admin: SessionUser;

  beforeAll(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
    await seedScheduler();
    admin = actor(adminId, ["ADMIN"]);
  });
  afterAll(async () => {
    await teardown();
  });

  async function mkTeacher(code: string) {
    const rows = await db
      .insert(schema.teachers)
      .values({ teacherCode: code, firstName: "T", lastName: code, language: "FILIPINO", status: "ACTIVE" })
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
        status: "ACTIVE",
      })
      .returning();
    return rows[0]!;
  }

  it("assignDestination closes the previous period, creates the new one, updates Current Destination, audits", async () => {
    const t = await mkTeacher("PNK-G-9910");
    const d1 = await mkDako("ILGD-9910");
    const d2 = await mkDako("ILGD-9911");

    const first = await assignDestination(t.id, d1.id, admin);
    expect(first.periodId).toBeTruthy();
    const second = await assignDestination(t.id, d2.id, admin);

    const history = await listForTeacher(t.id);
    expect(history).toHaveLength(2);
    const closed = history.find((h) => h.id === first.periodId)!;
    const open = history.find((h) => h.id === second.periodId)!;
    expect(closed.endDate).not.toBeNull();
    expect(open.endDate).toBeNull();
    const teacherAfter = (await db.select().from(schema.teachers).where(eq(schema.teachers.id, t.id)))[0]!;
    expect(teacherAfter.currentDestinationId).toBe(d2.id);

    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "DESTINATION_ASSIGNED"));
    expect(audits.filter((a) => a.entityId === t.id)).toHaveLength(2);
  });

  it("same-dako re-assign is a no-op (no period churn)", async () => {
    const t = await mkTeacher("PNK-G-9911");
    const d = await mkDako("ILGD-9912");
    await assignDestination(t.id, d.id, admin);
    const before = await listForTeacher(t.id);
    await assignDestination(t.id, d.id, admin);
    const after = await listForTeacher(t.id);
    expect(after.length).toBe(before.length);
  });

  it("§9 destined-teacher change: assigning a new teacher closes the previous holder's period (never overlapping); one active per dako", async () => {
    const t1 = await mkTeacher("PNK-G-9912");
    const t2 = await mkTeacher("PNK-G-9913");
    const d = await mkDako("ILGD-9913");
    const dOther = await mkDako("ILGD-9914");

    await assignDestination(t1.id, d.id, admin);
    // §9 — when the destined teacher changes, the previous record is closed
    // (end-dated, preserved) and the new one created — never two active.
    await assignDestination(t2.id, d.id, admin);
    const t1Periods = await listForTeacher(t1.id);
    expect(t1Periods).toHaveLength(1);
    expect(t1Periods[0]!.endDate).not.toBeNull(); // closed, not deleted
    const dakoView = await listForDako(d.id);
    expect(dakoView.filter((p) => p.endDate === null)).toHaveLength(1); // exactly one active
    expect(dakoView[0]!.teacherId).toBe(t2.id);

    // Moving t1 elsewhere gives t1 exactly one open period on the new dako.
    await assignDestination(t1.id, dOther.id, admin);
    const t1Open = (await listForTeacher(t1.id)).find((p) => !p.endDate);
    expect(t1Open!.dakoId).toBe(dOther.id);
  });

  it("history survives teacher INACTIVE and dako DISABLED (no cascade, no rewrite)", async () => {
    const t = await mkTeacher("PNK-G-9914");
    const d = await mkDako("ILGD-9915");
    await assignDestination(t.id, d.id, admin);
    await db
      .update(schema.teachers)
      .set({ status: "INACTIVE", dateInactive: "2099-01-01", inactiveReason: "moved" })
      .where(eq(schema.teachers.id, t.id));
    await db
      .update(schema.dako)
      .set({ status: "DISABLED", dateDisabled: "2099-01-01", disableReason: "closed" })
      .where(eq(schema.dako.id, d.id));
    const history = await listForTeacher(t.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.endDate).toBeNull(); // untouched by status changes
  });

  it("INVARIANT 3 — weekly assignment create/clear writes ZERO destination-history rows", async () => {
    const t = await mkTeacher("PNK-G-9915");
    const d = await mkDako("ILGD-9916");
    const weekRows = await db
      .insert(schema.weeks)
      .values({ year: 2098, isoWeekNumber: 1, startDate: "2098-01-05", endDate: "2098-01-11" })
      .returning();
    const weekId = weekRows[0]!.id;

    const before = await db.select().from(schema.destinationHistory);
    const created = await createAssignment(
      { weekId, dakoId: d.id, teacherId: t.id, assignmentType: "SUGO" },
      actor(adminId, ["ADMIN"]),
    );
    await clearAssignment(
      created.assignment.id,
      { clearType: "CHANGE_OF_SUGUAN", reason: "rebalance" } as never,
      actor(adminId, ["ADMIN"]),
    );
    const after = await db.select().from(schema.destinationHistory);
    expect(after.length).toBe(before.length); // no rows created/closed by scheduling
    const teacherRow = (await db.select().from(schema.teachers).where(eq(schema.teachers.id, t.id)))[0]!;
    expect(teacherRow.currentDestinationId).toBeNull(); // scheduling never sets it
  });

  it("clear Current Destination closes (never deletes) the active period; both views read one table", async () => {
    const { changeCurrentDestination } = await import("@/server/services/teacher.service");
    const t = await mkTeacher("PNK-G-9916");
    const d = await mkDako("ILGD-9917");
    await assignDestination(t.id, d.id, admin);

    await changeCurrentDestination(t.id, null, "teacher relocated away", admin);
    const teacherRow = (await db.select().from(schema.teachers).where(eq(schema.teachers.id, t.id)))[0]!;
    expect(teacherRow.currentDestinationId).toBeNull();
    const history = await listForTeacher(t.id);
    expect(history).toHaveLength(1); // preserved, not deleted
    expect(history[0]!.endDate).not.toBeNull();

    // Teacher view and dako view see the same single normalized record.
    const dakoView = await listForDako(d.id);
    expect(dakoView).toHaveLength(1);
    expect(dakoView[0]!.teacherId).toBe(t.id);
    expect(dakoView[0]!.endDate).toBe(history[0]!.endDate);
  });

  it("correctPeriod requires a reason, is audited, and preserves the HISTORICAL-style record semantics", async () => {
    const t = await mkTeacher("PNK-G-9917");
    const d = await mkDako("ILGD-9918");
    const { periodId } = await assignDestination(t.id, d.id, admin);
    const corrected = await correctPeriod(periodId, { endDate: "2099-06-30" }, "recorded period ended mid-year", admin);
    expect(corrected.endDate).toBe("2099-06-30");
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "DESTINATION_CORRECTED"));
    expect(audits.filter((a) => a.entityId === periodId)).toHaveLength(1);
    await expect(correctPeriod(periodId, { startDate: "2099-07-01" }, "   ", admin)).rejects.toThrow(/reason/);
  });
});
