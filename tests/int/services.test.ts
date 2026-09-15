import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import { TeacherService, DakoService, WeekService, AvailabilityService, AssignmentService, NotificationService } from "@/server/services";
import { bootstrapInitialAdmin } from "@/server/auth/bootstrap";
import { login, changePassword } from "@/server/auth/auth.service";
import { getDb } from "@/server/db/client";
import { isoWeek } from "@/lib/iso-week";

function actor(userId: string, roles: string[]) {
  return {
    userId,
    email: "x@test.local",
    fullName: "X",
    mustChangePassword: false,
    roleCodes: roles,
    permissions: [],
  };
}

beforeAll(async () => {
  await resetTestDb();
});

afterAll(async () => {
  await teardown();
});

describe("auth: bootstrap + login + change-password", () => {
  it("bootstraps the initial admin exactly once (secret-driven)", async () => {
    process.env.INITIAL_ADMIN_EMAIL = "bootstrap@test.local";
    process.env.INITIAL_ADMIN_PASSWORD = "BootstrapPass1!";
    const first = await bootstrapInitialAdmin();
    expect(first.created).toBe(true);
    const second = await bootstrapInitialAdmin();
    expect(second.created).toBe(false); // idempotent
    const rows = await db.select().from(schema.users).where(drizzleSql`email = 'bootstrap@test.local'`);
    expect(rows[0]!.mustChangePassword).toBe(true);
    const roles = await db
      .select({ code: schema.roles.code })
      .from(schema.userRoles)
      .innerJoin(schema.roles, drizzleSql`roles.id = user_roles.role_id`)
      .where(drizzleSql`user_id = ${rows[0]!.id}`);
    expect(roles.map((r) => r.code)).toEqual(["ADMIN"]);
  });

  it("refuses to bootstrap without a password secret", async () => {
    const saved = process.env.INITIAL_ADMIN_PASSWORD;
    delete process.env.INITIAL_ADMIN_PASSWORD;
    process.env.INITIAL_ADMIN_EMAIL = "nosecret@test.local";
    await expect(bootstrapInitialAdmin()).rejects.toThrow(/INITIAL_ADMIN_PASSWORD/);
    process.env.INITIAL_ADMIN_PASSWORD = saved;
  });

  it("logs in and enforces must_change_password rotation", async () => {
    const res = await login("bootstrap@test.local", "BootstrapPass1!");
    expect(res.mustChangePassword).toBe(true);
    await changePassword(res.userId, "BootstrapPass1!", "RotatedPass2!");
    const rows = await db.select().from(schema.users).where(drizzleSql`email = 'bootstrap@test.local'`);
    expect(rows[0]!.mustChangePassword).toBe(false);
    await expect(login("bootstrap@test.local", "BootstrapPass1!")).rejects.toThrow();
    await expect(login("bootstrap@test.local", "wrong")).rejects.toThrow();
  });
});

describe("teacher service (§8/§9/§14)", () => {
  let adminId: string;
  beforeAll(async () => { adminId = await seedAdmin(); });

  it("creates and deactivates with reason + audit", async () => {
    const a = actor(adminId, ["ADMIN"]);
    const t = await TeacherService.createTeacher({ teacherCode: "TS-1", firstName: "Maria", lastName: "Santos", language: "FILIPINO", birthday: "1990-01-31" }, a);
    expect(t.status).toBe("ACTIVE");
    const deactivated = await TeacherService.deactivateTeacher(t.id, "moved away", a);
    expect(deactivated.status).toBe("INACTIVE");
    expect(deactivated.dateInactive).toBeTruthy();
    const audits = await db.select().from(schema.auditLogs).where(drizzleSql`entity_id = ${t.id}`);
    expect(audits.map((x) => x.action)).toContain("DEACTIVATED_TEACHER");
  });

  it("rejects duplicate teacher codes", async () => {
    const a = actor(adminId, ["ADMIN"]);
    await TeacherService.createTeacher({ teacherCode: "TS-DUP", firstName: "A", lastName: "B", language: "ENGLISH" }, a);
    await expect(TeacherService.createTeacher({ teacherCode: "TS-DUP", firstName: "C", lastName: "D", language: "ENGLISH" }, a)).rejects.toThrow(/already exists/);
  });
});

describe("dako service (§11/§13)", () => {
  let adminId: string;
  beforeAll(async () => { adminId = await seedAdmin(); });

  it("creates and soft-disables with reason", async () => {
    const a = actor(adminId, ["ADMIN"]);
    const d = await DakoService.createDako({ dakoCode: "DS-1", name: "Dako Uno", address: "1 Street", dateEstablished: "2001-06-15", worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO" }, a);
    const dis = await DakoService.disableDako(d.id, "merged", a);
    expect(dis.status).toBe("DISABLED");
    expect(dis.dateDisabled).toBeTruthy();
    // still readable for history
    const got = await DakoService.getDako(d.id);
    expect(got.dateEstablished).toBe("2001-06-15");
  });
});

describe("assignment service (§19-§24)", () => {
  let adminId: string;
  let schedId: string;
  beforeAll(async () => {
    adminId = await seedAdmin();
    schedId = await seedScheduler();
  });

  it("creates manual assignment and enforces eligibility + lifecycle", async () => {
    const admin = actor(adminId, ["ADMIN"]);
    const sched = actor(schedId, ["SCHEDULER"]);
    const filTeacher = await TeacherService.createTeacher({ teacherCode: "TA-F", firstName: "Fil", lastName: "Only", language: "FILIPINO" }, admin);
    const engDako = await DakoService.createDako({ dakoCode: "DA-E", name: "English Dako", address: "2 Ave", dateEstablished: "2005-05-05", worshipDay: "SUNDAY", worshipTime: "10:00", language: "ENGLISH" }, admin);
    const filDako = await DakoService.createDako({ dakoCode: "DA-F", name: "Fil Dako", address: "3 Ave", dateEstablished: "2005-05-05", worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO" }, admin);
    const week = await WeekService.getOrCreateWeek(2088, 30);

    // FILIPINO teacher → ENGLISH dako: blocked without override
    await expect(
      AssignmentService.createAssignment({ weekId: week.id, dakoId: engDako.id, teacherId: filTeacher.id, assignmentType: "SUGO" }, sched),
    ).rejects.toThrow(/cannot serve/);

    // ADMIN override is allowed and recorded
    const res = await AssignmentService.createAssignment(
      { weekId: week.id, dakoId: engDako.id, teacherId: filTeacher.id, assignmentType: "SUGO", overrideReason: "shortage of english speakers" },
      admin,
    );
    expect(res.override).toBe(true);
    expect(res.assignment.assignmentSource).toBe("OVERRIDE");

    // One per teacher per week
    await expect(
      AssignmentService.createAssignment({ weekId: week.id, dakoId: filDako.id, teacherId: filTeacher.id, assignmentType: "RESERBA" }, sched),
    ).rejects.toThrow(/already has an assignment/);

    // Duplicate slot blocked
    const other = await TeacherService.createTeacher({ teacherCode: "TA-E", firstName: "Eng", lastName: "Speak", language: "ENGLISH" }, admin);
    await expect(
      AssignmentService.createAssignment({ weekId: week.id, dakoId: engDako.id, teacherId: other.id, assignmentType: "SUGO" }, sched),
    ).rejects.toThrow(/already filled/);

    // Week immutability: finalize then attempt change
    await WeekService.setWeekStatus(week.id, { status: "FINALIZED" }, admin);
    await expect(
      AssignmentService.createAssignment({ weekId: week.id, dakoId: filDako.id, teacherId: other.id, assignmentType: "RESERBA" }, sched),
    ).rejects.toThrow(/FINALIZED/);

    // Unlock is ADMIN-only with mandatory reason
    await expect(WeekService.setWeekStatus(week.id, { status: "DRAFT" }, sched)).rejects.toThrow(/ADMIN/);
    await WeekService.setWeekStatus(week.id, { status: "DRAFT", reason: "correction needed" }, admin);

    // Change assignment writes history (§25)
    await AssignmentService.changeAssignment(res.assignment.id, { teacherId: other.id, reason: "reassignment" }, admin);
    const hist = await AssignmentService.getAssignmentHistory(res.assignment.id);
    expect(hist.length).toBeGreaterThanOrEqual(2);
  });

  it("counts assignments via the counting model (§35)", async () => {
    const rows = await AssignmentService.getAssignmentCounts();
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe("availability service (§17/§18)", () => {
  let adminId: string;
  beforeAll(async () => { adminId = await seedAdmin(); });

  it("upserts weekly availability and never touches the profile", async () => {
    const a = actor(adminId, ["ADMIN"]);
    const t = await TeacherService.createTeacher({ teacherCode: "TB-1", firstName: "Abs", lastName: "Ent", language: "FILIPINO" }, a);
    const w = await WeekService.getOrCreateWeek(2087, 38);
    const before = await db.select().from(schema.teachers).where(drizzleSql`id = ${t.id}`);
    const rec = await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "ABSENT", reason: "personal appointment" }, a);
    expect(rec.reason).toBe("personal appointment");
    const after = await db.select().from(schema.teachers).where(drizzleSql`id = ${t.id}`);
    expect(after[0]!.status).toBe(before[0]!.status); // profile untouched (§18)
    // duplicate upsert replaces, not duplicates
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "AVAILABLE" }, a);
    const list = await AvailabilityService.listAvailabilityForWeek(w.id);
    expect(list).toHaveLength(1);
    // absent reason required
    await expect(
      AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "ABSENT" }, a),
    ).rejects.toThrow(/reason/);
  });

  it("detects previous-week absence for the future scheduler (§18)", async () => {
    const a = actor(adminId, ["ADMIN"]);
    const t = await TeacherService.createTeacher({ teacherCode: "TB-2", firstName: "Prev", lastName: "Abs", language: "FILIPINO" }, a);
    const w = await WeekService.getOrCreateWeek(2086, 1);
    await AvailabilityService.upsertAvailability({ teacherId: t.id, weekId: w.id, availabilityStatus: "ABSENT", reason: "sick" }, a);
    // Week 2 of the same ISO year follows week 1.
    const next = await WeekService.getOrCreateWeek(2086, 2);
    const wasAbsent = await AvailabilityService.wasAbsentPreviousWeek(t.id, 2086, 2);
    void next;
    expect(wasAbsent).toBe(true);
    void w;
  });
});

describe("notifications (§27/§28)", () => {
  let adminId: string;
  beforeAll(async () => { adminId = await seedAdmin(); });

  it("dedupes anniversary notifications per dako+year+type", async () => {
    const a = actor(adminId, ["ADMIN"]);
    const d = await DakoService.createDako({ dakoCode: "DN-1", name: "Anniv Dako", address: "4 Ave", dateEstablished: "2000-03-10", worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO" }, a);
    const first = await NotificationService.recordDakoAnniversaryNotification(d.id, 2026, "TODAY");
    expect(first.created).toBe(true);
    expect(first.notifications).toBeGreaterThan(0);
    const second = await NotificationService.recordDakoAnniversaryNotification(d.id, 2026, "TODAY");
    expect(second.created).toBe(false); // dedupe
    // different year → new notification allowed
    const third = await NotificationService.recordDakoAnniversaryNotification(d.id, 2027, "TODAY");
    expect(third.created).toBe(true);
  });

  it("stage scan finds dako in its notification window", async () => {
    const a = actor(adminId, ["ADMIN"]);
    await DakoService.createDako({ dakoCode: "DN-2", name: "Today Dako", address: "5 Ave", dateEstablished: `${new Date().getUTCFullYear() - 10}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}-${String(new Date().getUTCDate()).padStart(2, "0")}`, worshipDay: "SUNDAY", worshipTime: "09:00", language: "FILIPINO" }, a);
    const due = await NotificationService.dueAnniversaryNotifications();
    expect(due.some((x) => x.dakoName === "Today Dako" && x.stage === "TODAY")).toBe(true);
  });
});

describe("getOrCreateWeek (§15)", () => {
  it("is idempotent and rejects invalid week numbers", async () => {
    const w1 = await WeekService.getOrCreateWeek(2085, 52);
    const w2 = await WeekService.getOrCreateWeek(2085, 52);
    expect(w1.id).toBe(w2.id);
    await expect(WeekService.getOrCreateWeek(2085, 53)).rejects.toThrow(/only 52/); // 2085 has 52 ISO weeks
  });
});

void isoWeek;
void getDb;
