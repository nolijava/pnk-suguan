/**
 * Phase 8 — Reports + Notifications tests.
 *
 * REPORTS (read-only): annual per-type grouping + source fidelity
 * (HISTORICAL stays HISTORICAL), weekly report incl. not-started weeks
 * (never auto-created — read-only proof), teacher/dako history filters +
 * assignedAt, source summary cross-tab, and a READ-ONLY PROOF that report
 * calls leave assignments/availability/audit/destination_history/weeks
 * untouched.
 *
 * NOTIFICATIONS: anniversary stage windows (1-month / today boundaries),
 * idempotent scan (repeat creates nothing new), fan-out to ACTIVE admins,
 * mark-read ownership (cannot mark another user's rows), navigation mapping.
 * RBAC: hasPermission for reports.read / notifications.read / scan.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, ne, sql as drizzleSql } from "drizzle-orm";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db, sql as testSql } from "./helpers";
import * as schema from "@/server/db/schema";
import {
  TeacherService,
  DakoService,
  WeekService,
  AssignmentService,
  NotificationService,
} from "@/server/services";
import {
  annualTypeReport,
  weeklyReport,
  teacherAssignmentReport,
  dakoAssignmentReport,
  sourceSummaryReport,
} from "@/server/services/reports.service";
import { anniversaryStage } from "@/lib/anniversary";
import { notificationHref } from "@/lib/notification-links";
import { hasPermission } from "@/server/auth/permissions";
import type { SessionUser } from "@/server/auth/session";

function actor(userId: string, roles: string[]): SessionUser {
  return { userId, email: "x@test.local", fullName: "X", mustChangePassword: false, roleCodes: roles, permissions: [] };
}

const COUNTS = {
  assignments: async () => (await db.select({ n: drizzleSql<number>`count(*)::int` }).from(schema.assignments))[0]!.n,
  availability: async () => (await db.select({ n: drizzleSql<number>`count(*)::int` }).from(schema.teacherAvailability))[0]!.n,
  audit: async () => (await db.select({ n: drizzleSql<number>`count(*)::int` }).from(schema.auditLogs))[0]!.n,
  destHistory: async () => (await db.select({ n: drizzleSql<number>`count(*)::int` }).from(schema.destinationHistory))[0]!.n,
  weeks: async () => (await db.select({ n: drizzleSql<number>`count(*)::int` }).from(schema.weeks))[0]!.n,
  notifications: async () => (await db.select({ n: drizzleSql<number>`count(*)::int` }).from(schema.notifications))[0]!.n,
  annivDedupe: async () => (await db.select({ n: drizzleSql<number>`count(*)::int` }).from(schema.dakoAnniversaryNotifications))[0]!.n,
};

let admin: SessionUser;
let sched: SessionUser;
let t1: Awaited<ReturnType<typeof TeacherService.createTeacher>>;
let t2: Awaited<ReturnType<typeof TeacherService.createTeacher>>;
let t3: Awaited<ReturnType<typeof TeacherService.createTeacher>>;
let t4: Awaited<ReturnType<typeof TeacherService.createTeacher>>;
let dakoA: Awaited<ReturnType<typeof DakoService.createDako>>;
let dakoB: Awaited<ReturnType<typeof DakoService.createDako>>;
let annivDako: Awaited<ReturnType<typeof DakoService.createDako>>;

beforeAll(async () => {
  await resetTestDb();
  const adminId = await seedAdmin();
  const schedId = await seedScheduler();
  admin = actor(adminId, ["ADMIN"]);
  sched = actor(schedId, ["SCHEDULER"]);

  t1 = await TeacherService.createTeacher({ teacherCode: "P8-T1", firstName: "Ana", lastName: "Reyes", language: "FILIPINO" }, admin);
  t2 = await TeacherService.createTeacher({ teacherCode: "P8-T2", firstName: "Ben", lastName: "Cruz", language: "ENGLISH" }, admin);
  t3 = await TeacherService.createTeacher({ teacherCode: "P8-T3", firstName: "Carlo", lastName: "Diaz", language: "ENGLISH" }, admin);
  t4 = await TeacherService.createTeacher({ teacherCode: "P8-T4", firstName: "Dina", lastName: "Flores", language: "FILIPINO" }, admin);
  dakoA = await DakoService.createDako(
    {
      dakoCode: "P8-D1", name: "Dako P8 Alpha", address: "Addr", dateEstablished: "2000-03-10",
      worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO",
    },
    admin,
  );
  dakoB = await DakoService.createDako(
    {
      dakoCode: "P8-D2", name: "Dako P8 Beta", address: "Addr", dateEstablished: "1995-07-04",
      worshipDay: "SUNDAY", worshipTime: "17:00", language: "ENGLISH",
    },
    admin,
  );

  // Week 8 2078 — one assignment per teacher, every language pair legal.
  // AUTO is engine-produced, so that row is inserted directly (exactly what
  // generateSchedule writes); the manual service path always writes MANUAL.
  //   Alpha (FIL dako): SUGO t1 (FIL→FIL, AUTO) · RESERBA_II t4 (FIL→FIL, MANUAL)
  //   Beta  (EN dako):  RESERBA t3 (EN→EN, OVERRIDE) · SUGO t2 (EN→EN, HISTORICAL)
  const w = await WeekService.getOrCreateWeek(2078, 8);
  await db.insert(schema.assignments).values({
    weekId: w.id, dakoId: dakoA.id, teacherId: t1.id, assignmentType: "SUGO",
    assignmentSource: "AUTO", status: "ASSIGNED",
  });
  await AssignmentService.createAssignment(
    { weekId: w.id, dakoId: dakoA.id, teacherId: t4.id, assignmentType: "RESERBA_II" },
    admin,
  );
  await AssignmentService.createAssignment(
    { weekId: w.id, dakoId: dakoB.id, teacherId: t3.id, assignmentType: "RESERBA", overrideReason: "override probe" },
    admin,
  );
  await db
    .insert(schema.assignments)
    .values({
      weekId: w.id, dakoId: dakoB.id, teacherId: t2.id, assignmentType: "SUGO",
      assignmentSource: "HISTORICAL", status: "ASSIGNED",
    });

  // Dako with a known anniversary for stage/idempotence tests: established
  // 2000-03-10 → anniversary Mar 10. "Now" is set per-test via fake dates.
  annivDako = dakoA;
});

afterAll(async () => {
  await teardown();
});

describe("Phase 8 — reports (read-only)", () => {
  it("annual type report groups by dako with source fidelity and summary", async () => {
    const sugo = await annualTypeReport(2078, "SUGO");
    expect(sugo.year).toBe(2078);
    expect(sugo.isoWeeks).toBe(52);
    const alphaSugo = sugo.rows.filter((r) => r.dakoId === dakoA.id);
    expect(alphaSugo).toHaveLength(1);
    expect(alphaSugo[0]!.teacherId).toBe(t1.id);
    expect(alphaSugo[0]!.assignmentSource).toBe("AUTO");
    const betaSugo = sugo.rows.filter((r) => r.dakoId === dakoB.id);
    expect(betaSugo).toHaveLength(1);
    expect(betaSugo[0]!.assignmentSource).toBe("HISTORICAL"); // never remapped

    const reserba = await annualTypeReport(2078, "RESERBA");
    expect(reserba.summary.bySource["OVERRIDE"]).toBe(1);
    expect(reserba.summary.totalAssigned).toBe(1);
    const reserbaIi = await annualTypeReport(2078, "RESERBA_II");
    expect(reserbaIi.summary.bySource["MANUAL"]).toBe(1);
  });

  it("weekly report merges persisted rows with unassigned reason codes", async () => {
    // A fresh week: the engine plan supplies UNASSIGNED reason codes.
    const w9 = await WeekService.getOrCreateWeek(2078, 9);
    const rep9 = await weeklyReport(2078, 9);
    expect(rep9.week?.id).toBe(w9.id);
    const unassigned = rep9.sections.flatMap((s) => s.slots).filter((s) => !s.teacherName);
    expect(unassigned.length).toBeGreaterThan(0);
    for (const s of unassigned) {
      expect(s.reasonCode).toBeTruthy();
      expect(s.source).toBeNull();
    }
    // Week 8: the seeded AUTO/MANUAL/OVERRIDE/HISTORICAL rows appear with real sources.
    const rep8 = await weeklyReport(2078, 8);
    const sources = rep8.sections.flatMap((s) => s.slots).map((s) => s.source).filter(Boolean);
    expect(sources).toContain("AUTO");
    expect(sources).toContain("MANUAL");
    expect(sources).toContain("OVERRIDE");
    expect(sources).toContain("HISTORICAL");
  });

  it("weekly report on a not-started week returns a note and does NOT create the week", async () => {
    const before = await COUNTS.weeks();
    const rep = await weeklyReport(2088, 50);
    expect(rep.week).toBeNull();
    expect(rep.note).toMatch(/has not been started/);
    expect(rep.summary).toBeNull();
    expect(await COUNTS.weeks()).toBe(before); // read-only: no auto-create
  });

  it("teacher report filters by teacher/year/source and reports assignedAt", async () => {
    const rep = await teacherAssignmentReport({ teacherId: t1.id });
    expect(rep.teacher?.code).toBe("P8-T1");
    expect(rep.rows.length).toBeGreaterThanOrEqual(1);
    expect(rep.rows.every((r) => r.teacherId === t1.id)).toBe(true);
    expect(rep.rows.every((r) => r.assignedAt instanceof Date)).toBe(true);

    const bySource = await teacherAssignmentReport({ source: "HISTORICAL" });
    expect(bySource.rows.length).toBeGreaterThan(0);
    expect(bySource.rows.every((r) => r.assignmentSource === "HISTORICAL")).toBe(true);

    const byYear = await teacherAssignmentReport({ teacherId: t1.id, year: 2078 });
    expect(byYear.rows.every((r) => r.year === 2078)).toBe(true);
  });

  it("dako report filters by dako and keeps HISTORICAL identifiable", async () => {
    const rep = await dakoAssignmentReport({ dakoId: dakoB.id });
    expect(rep.dako?.code).toBe("P8-D2");
    const hist = rep.rows.filter((r) => r.assignmentSource === "HISTORICAL");
    expect(hist.length).toBe(1);
    expect(hist[0]!.teacherId).toBe(t2.id);
  });

  it("source summary cross-tab counts AUTO/MANUAL/OVERRIDE/HISTORICAL", async () => {
    const rep = await sourceSummaryReport(2078);
    expect(rep.bySource["AUTO"]).toBe(1);
    expect(rep.bySource["MANUAL"]).toBe(1);
    expect(rep.bySource["OVERRIDE"]).toBe(1);
    expect(rep.bySource["HISTORICAL"]).toBe(1);
    expect(rep.crossTab["HISTORICAL"]?.SUGO).toBe(1);
  });

  it("READ-ONLY PROOF: report calls never mutate schedule/availability/audit/destination-history/weeks", async () => {
    const before = {
      assignments: await COUNTS.assignments(),
      availability: await COUNTS.availability(),
      audit: await COUNTS.audit(),
      destHistory: await COUNTS.destHistory(),
      weeks: await COUNTS.weeks(),
    };
    await annualTypeReport(2078, "SUGO");
    await annualTypeReport(2078, "RESERBA");
    await annualTypeReport(2078, "RESERBA_II");
    await weeklyReport(2078, 8);
    await teacherAssignmentReport({});
    await dakoAssignmentReport({});
    await sourceSummaryReport(2078);
    await sourceSummaryReport();
    const after = {
      assignments: await COUNTS.assignments(),
      availability: await COUNTS.availability(),
      audit: await COUNTS.audit(),
      destHistory: await COUNTS.destHistory(),
      weeks: await COUNTS.weeks(),
    };
    expect(after).toEqual(before);
  });
});

describe("Phase 8 — notifications (delivery + integrity)", () => {
  it("anniversary stage windows use the existing UTC logic (month-aware 1-month, today)", async () => {
    const established = "2000-03-10";
    expect(anniversaryStage(established, new Date("2078-02-10T12:00:00Z"))).toBe("ONE_MONTH_BEFORE");
    expect(anniversaryStage(established, new Date("2078-03-10T12:00:00Z"))).toBe("TODAY");
    expect(anniversaryStage(established, new Date("2078-03-09T12:00:00Z"))).toBe("ONE_DAY_BEFORE");
    expect(anniversaryStage(established, new Date("2078-06-01T12:00:00Z"))).toBeNull();
  });

  it("scan is idempotent: repeating it creates no duplicate notifications", async () => {
    // Make "today" the 1-month-before day of the anniversary via a fake now:
    // the scan helper takes now as a parameter.
    const now = new Date(`${nextAnnivYearFor(annivDako.dateEstablished)}-02-10T00:00:00Z`);
    const first = await NotificationService.runDueAnniversaryScan(now);
    expect(first.dueStages).toBe(1);
    expect(first.createdNotifications).toBeGreaterThan(0);
    const dedupeAfterFirst = await COUNTS.annivDedupe();
    const notifsAfterFirst = await COUNTS.notifications();

    const second = await NotificationService.runDueAnniversaryScan(now);
    expect(second.createdNotifications).toBe(0);
    expect(await COUNTS.annivDedupe()).toBe(dedupeAfterFirst);
    expect(await COUNTS.notifications()).toBe(notifsAfterFirst);
  });

  it("fan-out targets ACTIVE admins only; scheduler/other users get none", async () => {
    const rows = await db
      .select({ userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(eq(schema.notifications.notificationType, "ONE_MONTH_BEFORE"));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const roles = await db
        .select({ code: schema.roles.code, status: schema.users.status })
        .from(schema.userRoles)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
        .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
        .where(eq(schema.userRoles.userId, r.userId));
      expect(roles.some((x) => x.code === "ADMIN" && x.status === "ACTIVE")).toBe(true);
    }
  });

  it("mark-read is ownership-scoped: a user cannot mark another user's notification", async () => {
    const notif = (
      await db.select().from(schema.notifications).where(eq(schema.notifications.notificationType, "ONE_MONTH_BEFORE")).limit(1)
    )[0]!;
    const adminRows = await NotificationService.markNotificationsRead(notif.userId, [notif.id]);
    expect(adminRows).toBe(1);
    // Another user cannot mark it (already read → 0, but prove with a fresh unread row):
    const other = (
      await db.select({ id: schema.users.id }).from(schema.users).where(ne(schema.users.id, notif.userId)).limit(1)
    )[0]!;
    const fresh = (
      await db.select().from(schema.notifications).where(eq(schema.notifications.id, notif.id)).limit(1)
    )[0]!;
    expect(fresh.readAt).not.toBeNull();
    // Ownership scope re-proved on a fresh unread notification for the other user:
    const fresh2 = (
      await db
        .insert(schema.notifications)
        .values({ userId: other.id, notificationType: "TODAY", title: "probe" })
        .returning()
    )[0]!;
    expect(await NotificationService.markNotificationsRead(notif.userId, [fresh2.id])).toBe(0);
    expect(await NotificationService.markNotificationsRead(other.id, [fresh2.id])).toBe(1);
  });

  it("navigation maps relatedEntityType to pages; week → /schedule", () => {
    expect(notificationHref("dako", "abc")).toBe("/dako/abc");
    expect(notificationHref("dako", null)).toBe("/dako");
    expect(notificationHref("week", "whatever")).toBe("/schedule");
    expect(notificationHref("teacher", "abc")).toBe("/teachers/abc");
    expect(notificationHref(null, null)).toBeNull();
  });
});

describe("Phase 8 — RBAC permission model", () => {
  it("reports.read is held by ADMIN, SCHEDULER, VIEWER (and SUPER_ADMIN inherits)", () => {
    expect(hasPermission(["ADMIN"], "reports.read")).toBe(true);
    expect(hasPermission(["SCHEDULER"], "reports.read")).toBe(true);
    expect(hasPermission(["VIEWER"], "reports.read")).toBe(true);
    expect(hasPermission(["SUPER_ADMIN"], "reports.read")).toBe(true);
  });

  it("notifications.write (scan) is ADMIN/SUPER_ADMIN only; read is universal", () => {
    expect(hasPermission(["ADMIN"], "notifications.write")).toBe(true);
    expect(hasPermission(["SUPER_ADMIN"], "notifications.write")).toBe(true);
    expect(hasPermission(["SCHEDULER"], "notifications.write")).toBe(false);
    expect(hasPermission(["VIEWER"], "notifications.write")).toBe(false);
    expect(hasPermission(["VIEWER"], "notifications.read")).toBe(true);
  });
});

/** Next occurrence year of March-10-style anniversary relative to a stable future date. */
function nextAnnivYearFor(established: string): number {
  void established;
  return 2078; // matches the test-clock dates used above
}
