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

  it("§9 destined-teacher change: assigning a new teacher closes the previous holder's period (never overlapping); one active per dako when no duty is recorded", async () => {
    const t1 = await mkTeacher("PNK-G-9912");
    const t2 = await mkTeacher("PNK-G-9913");
    const d = await mkDako("ILGD-9913");
    const dOther = await mkDako("ILGD-9914");

    await assignDestination(t1.id, d.id, admin);
    // §9 — when the destined teacher changes, the previous record is closed
    // (end-dated, preserved) and the new one created — never two active.
    // New Update #8 — duty-less periods share ONE slot (''), so the ORIGINAL
    // one-active-per-dako rule is exactly what still applies here.
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

  // -------------------------------------------------------------------------
  // New Update #6/#7/#8 — duty as a property of the destination relationship
  // -------------------------------------------------------------------------

  it("duty travels WITH the period: a destination change preserves the duty held at the previous dako", async () => {
    const t = await mkTeacher("PNK-G-9920");
    const d1 = await mkDako("ILGD-9920");
    const d2 = await mkDako("ILGD-9921");

    const first = await assignDestination(t.id, d1.id, admin, { duty: "DESTINADO" });
    expect(first.duty).toBe("DESTINADO");
    const second = await assignDestination(t.id, d2.id, admin, { duty: "KATUWANG" });
    expect(second.duty).toBe("KATUWANG");

    const history = await listForTeacher(t.id);
    expect(history).toHaveLength(2);
    const closed = history.find((h) => h.id === first.periodId)!;
    const open = history.find((h) => h.id === second.periodId)!;
    expect(closed.endDate).not.toBeNull();
    expect(closed.duty).toBe("DESTINADO"); // historical duty preserved, never rewritten
    expect(open.duty).toBe("KATUWANG");
    expect(open.endDate).toBeNull();

    // teachers.duty mirrors the OPEN relationship's duty (generation depends on it).
    const teacherRow = (await db.select().from(schema.teachers).where(eq(schema.teachers.id, t.id)))[0]!;
    expect(teacherRow.currentDestinationId).toBe(d2.id);
    expect(teacherRow.duty).toBe("KATUWANG");

    // The audit trail carries the duty on both sides of the change.
    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "DESTINATION_ASSIGNED"));
    const mine = audits.filter((a) => a.entityId === t.id);
    expect(mine).toHaveLength(2);
    expect((mine[1]!.newValue as { duty: string }).duty).toBe("KATUWANG");
  });

  it("one active holder per (dako, duty): a Destinado and a Katuwang coexist; a second Destinado replaces the first", async () => {
    const t1 = await mkTeacher("PNK-G-9921");
    const t2 = await mkTeacher("PNK-G-9922");
    const t3 = await mkTeacher("PNK-G-9923");
    const d = await mkDako("ILGD-9922");

    await assignDestination(t1.id, d.id, admin, { duty: "DESTINADO" });
    await assignDestination(t2.id, d.id, admin, { duty: "KATUWANG" });

    let view = await listForDako(d.id);
    expect(view.filter((p) => p.endDate === null)).toHaveLength(2); // both slots held
    expect(view.find((p) => p.duty === "DESTINADO")!.teacherId).toBe(t1.id);
    expect(view.find((p) => p.duty === "KATUWANG")!.teacherId).toBe(t2.id);

    // A second Destinado replaces the first — the Katuwang slot is untouched.
    await assignDestination(t3.id, d.id, admin, { duty: "DESTINADO" });
    view = await listForDako(d.id);
    const active = view.filter((p) => p.endDate === null);
    expect(active).toHaveLength(2);
    expect(active.find((p) => p.duty === "DESTINADO")!.teacherId).toBe(t3.id);
    expect(active.find((p) => p.duty === "KATUWANG")!.teacherId).toBe(t2.id);
    // The replaced Destinado is end-dated, never deleted.
    expect(view.find((p) => p.teacherId === t1.id)!.endDate).not.toBeNull();
  });

  it("a duty-bearing assignment also supersedes an UNLABELLED active period at the same dako", async () => {
    const t1 = await mkTeacher("PNK-G-9924");
    const t2 = await mkTeacher("PNK-G-9925");
    const d = await mkDako("ILGD-9923");

    await assignDestination(t1.id, d.id, admin); // legacy-style: no duty recorded
    await assignDestination(t2.id, d.id, admin, { duty: "KATUWANG" });

    const view = await listForDako(d.id);
    expect(view.filter((p) => p.endDate === null)).toHaveLength(1);
    expect(view.find((p) => !p.endDate)!.teacherId).toBe(t2.id);
    expect((await listForTeacher(t1.id))[0]!.endDate).not.toBeNull();
  });

  it("a duty-only change at the SAME dako updates the open period in place (no churn) and mirrors teachers.duty", async () => {
    const t = await mkTeacher("PNK-G-9926");
    const d = await mkDako("ILGD-9924");
    const first = await assignDestination(t.id, d.id, admin, { duty: "DESTINADO" });

    const again = await assignDestination(t.id, d.id, admin, { duty: "KATUWANG" });
    expect(again.periodId).toBe(first.periodId);
    const history = await listForTeacher(t.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.duty).toBe("KATUWANG");
    expect(history[0]!.startDate).toBe(first.startDate);
    const teacherRow = (await db.select().from(schema.teachers).where(eq(schema.teachers.id, t.id)))[0]!;
    expect(teacherRow.duty).toBe("KATUWANG");

    // An identical re-assign is still a true no-op (no audit noise).
    const before = (await db.select().from(schema.auditLogs)).length;
    await assignDestination(t.id, d.id, admin, { duty: "KATUWANG" });
    expect((await db.select().from(schema.auditLogs)).length).toBe(before);
  });

  it("only DESTINADO | KATUWANG are ever stored; a nonsense duty is rejected", async () => {
    const t = await mkTeacher("PNK-G-9927");
    const d = await mkDako("ILGD-9925");
    await expect(
      assignDestination(t.id, d.id, admin, { duty: "PRESIDENT" as never }),
    ).rejects.toThrow(/duty/);
    expect(await listForTeacher(t.id)).toHaveLength(0);
  });

  it("changeCurrentDestination requires a duty to SET a destination and stores it on the period", async () => {
    const { changeCurrentDestination } = await import("@/server/services/teacher.service");
    const t = await mkTeacher("PNK-G-9928");
    const d = await mkDako("ILGD-9926");

    // No duty → the rule is enforced server-side (never by hiding a control).
    await expect(changeCurrentDestination(t.id, d.id, "first posting", admin)).rejects.toThrow(/duty/);
    expect(await listForTeacher(t.id)).toHaveLength(0);

    const result = await changeCurrentDestination(t.id, d.id, "first posting", admin, "DESTINADO");
    expect(result.teacher.currentDestinationId).toBe(d.id);
    expect(result.teacher.duty).toBe("DESTINADO");
    const open = (await listForTeacher(t.id)).find((p) => !p.endDate)!;
    expect(open.duty).toBe("DESTINADO");

    // Clearing needs no duty and preserves the period (with its duty) in history.
    await changeCurrentDestination(t.id, null, "relocated away", admin);
    expect(await listForTeacher(t.id)).toHaveLength(1);
    expect((await listForTeacher(t.id))[0]!.duty).toBe("DESTINADO");
  });

  it("a master-data duty edit keeps the OPEN period aligned (one source of truth)", async () => {
    const { updateTeacher } = await import("@/server/services/teacher.service");
    const t = await mkTeacher("PNK-G-9929");
    const d = await mkDako("ILGD-9927");
    await assignDestination(t.id, d.id, admin, { duty: "DESTINADO" });

    await updateTeacher(t.id, { duty: "KATUWANG" }, admin);
    const open = (await listForTeacher(t.id)).find((p) => !p.endDate)!;
    expect(open.duty).toBe("KATUWANG");
    const teacherRow = (await db.select().from(schema.teachers).where(eq(schema.teachers.id, t.id)))[0]!;
    expect(teacherRow.duty).toBe("KATUWANG");
  });

  it("correctPeriod can fix a recorded duty — with a reason — and rejects an invalid one", async () => {
    const t = await mkTeacher("PNK-G-9930");
    const d = await mkDako("ILGD-9928");
    const { periodId } = await assignDestination(t.id, d.id, admin, { duty: "DESTINADO" });

    const fixed = await correctPeriod(periodId, { duty: "KATUWANG" }, "duty was recorded the wrong way round", admin);
    expect(fixed.duty).toBe("KATUWANG");
    await expect(correctPeriod(periodId, { duty: "SENATOR" as never }, "typo", admin)).rejects.toThrow(/duty/);
  });

  it("the widened slot rule is enforced by the DATABASE, not only by the service", async () => {
    const t1 = await mkTeacher("PNK-G-9931");
    const t2 = await mkTeacher("PNK-G-9932");
    const d = await mkDako("ILGD-9929");
    await assignDestination(t1.id, d.id, admin, { duty: "DESTINADO" });

    // A second OPEN Destinado for the same dako cannot be inserted directly.        
    await expect(
      db.insert(schema.destinationHistory).values({
        teacherId: t2.id,
        dakoId: d.id,
        startDate: "2099-01-01",
        duty: "DESTINADO",
      }),
    ).rejects.toThrow();
    // …while the OTHER slot is free by design.
    await assignDestination(t2.id, d.id, admin, { duty: "KATUWANG" });
    expect((await listForDako(d.id)).filter((p) => !p.endDate)).toHaveLength(2);
  });
});
