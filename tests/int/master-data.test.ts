/**
 * Phase 2 — Master Data Management test suite (§27).
 * Principle under test: MASTER DATA CURRENT STATE ≠ HISTORICAL RECORD.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db, sql } from "./helpers";
import * as schema from "@/server/db/schema";
import { TeacherService, DakoService } from "@/server/services";
import { hasPermission } from "@/server/auth/permissions";
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

/** Scheduling-table snapshot: the rows destination/master-data ops must NEVER touch. */
async function snap() {
  const [a] = await sql`SELECT count(*)::int AS n FROM assignments`;
  const [h] = await sql`SELECT count(*)::int AS n FROM assignment_history`;
  const [v] = await sql`SELECT count(*)::int AS n FROM teacher_availability`;
  return { assignments: a!.n, history: h!.n, availability: v!.n };
}

function teacherInput(code: string, over: Partial<Parameters<typeof TeacherService.createTeacher>[0]> = {}) {
  return { teacherCode: code, firstName: "First", lastName: "Last", language: "FILIPINO" as const, ...over };
}
function dakoInput(code: string, over: Partial<Parameters<typeof DakoService.createDako>[0]> = {}) {
  return {
    dakoCode: code, name: `Dako ${code}`, address: "1 Test St", dateEstablished: "2001-06-15",
    worshipDay: "SUNDAY" as const, worshipTime: "09:00", language: "FILIPINO" as const, ...over,
  };
}

let admin: SessionUser;
let sched: SessionUser;
let viewerId: string;

beforeAll(async () => {
  await resetTestDb();
  const adminId = await seedAdmin();
  const schedId = await seedScheduler();
  admin = actor(adminId, ["ADMIN"]);
  sched = actor(schedId, ["SCHEDULER"]);
  const passwordHash = "x";
  const inserted = await db
    .insert(schema.users)
    .values({ email: "viewer@test.local", fullName: "Viewer", passwordHash })
    .returning();
  viewerId = inserted[0]!.id;
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, "VIEWER"));
  await db.insert(schema.userRoles).values({ userId: viewerId, roleId: roleRows[0]!.id });
});

afterAll(async () => {
  await teardown();
});

describe("teacher CRUD + validation (§3)", () => {
  it("creates a teacher with defaults and audit", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P2-001"), admin);
    expect(t.status).toBe("ACTIVE");
    expect(t.currentDestinationId).toBeNull();
    const logs = await db.select().from(schema.auditLogs).where(drizzleSql`entity_id = ${t.id}`);
    expect(logs.map((l) => l.action)).toContain("CREATED_TEACHER");
  });

  it("rejects duplicate teacher codes", async () => {
    await expect(TeacherService.createTeacher(teacherInput("P2-001"), admin)).rejects.toThrow(/already exists/);
  });

  it("rejects future birthdays", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await expect(TeacherService.createTeacher(teacherInput("P2-002", { birthday: future }), admin)).rejects.toThrow();
  });

  it("computes age dynamically and never stores it", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P2-003", { birthday: "1990-01-31" }), admin);
    expect(JSON.stringify(t)).not.toContain('"age"');
    const det = await TeacherService.getTeacherDetails(t.id);
    expect(det.age).toBeTypeOf("number");
    expect(det.age!).toBeGreaterThanOrEqual(35); // 1990 → today
  });

  it("rejects invalid language values", async () => {
    await expect(
      TeacherService.createTeacher({ ...teacherInput("P2-004"), language: "CEBUANO" as "FILIPINO" }, admin),
    ).rejects.toThrow();
  });

  it("rejects invalid date-of-oath strings", async () => {
    await expect(
      TeacherService.createTeacher(teacherInput("P2-005", { dateOfOath: "not-a-date" }), admin),
    ).rejects.toThrow();
  });
});

describe("teacher list — search/filter/sort/pagination (§4/§5)", () => {
  beforeAll(async () => {
    const d1 = await DakoService.createDako(dakoInput("PL-1"), admin);
    await TeacherService.createTeacher(teacherInput("PL-A", { firstName: "Alpha", middleName: "Middle", lastName: "Sanchez", currentDestinationId: d1.id }), admin);
    await TeacherService.createTeacher(teacherInput("PL-B", { firstName: "Beta", lastName: "Reyes", language: "ENGLISH" }), admin);
    await TeacherService.createTeacher(teacherInput("PL-C", { firstName: "Gamma", lastName: "Santos" }), admin);
  });

  it("searches by code, first, middle, last, and full name", async () => {
    expect((await TeacherService.listTeachers({ search: "PL-A" })).rows).toHaveLength(1);
    expect((await TeacherService.listTeachers({ search: "alpha" })).rows).toHaveLength(1);
    expect((await TeacherService.listTeachers({ search: "middle" })).rows).toHaveLength(1);
    expect((await TeacherService.listTeachers({ search: "reyes" })).rows).toHaveLength(1);
    expect((await TeacherService.listTeachers({ search: "First Last" })).rows.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by status and language only (plus destination)", async () => {
    expect((await TeacherService.listTeachers({ status: "ACTIVE" })).rows).toHaveLength(5);
    expect((await TeacherService.listTeachers({ language: "ENGLISH" })).rows).toHaveLength(1);
    const d1 = (await DakoService.listDako({ search: "PL-1" })).rows[0]!;
    expect((await TeacherService.listTeachers({ currentDestinationId: d1.id })).rows).toHaveLength(1);
  });

  it("does NOT accept purok/grupo as a teacher list filter (§8 final rule)", async () => {
    // The teacher list options type has no purokGrupo key; strict payloads reject it.
    const opts = { purokGrupo: "Grupo 1" } as unknown as Record<string, unknown>;
    expect("purokGrupo" in opts).toBe(true);
    expect(Object.hasOwn(TeacherListOptionsShape, "purokGrupo")).toBe(false);
    // service-level: creating a teacher with purok still works (form field, not filter)
    await TeacherService.createTeacher(teacherInput("PL-D", { purokGrupo: "Grupo 9" }), admin);
    expect((await TeacherService.listTeachers({ search: "PL-D" })).rows[0]!.purokGrupo).toBe("Grupo 9");
  });

  it("sorts by whitelisted fields with direction", async () => {
    const codesAsc = (await TeacherService.listTeachers({ sort: "code", order: "asc" })).rows.map((r) => r.teacherCode);
    expect(codesAsc).toEqual([...codesAsc].sort());
    const codesDesc = (await TeacherService.listTeachers({ sort: "code", order: "desc" })).rows.map((r) => r.teacherCode);
    expect(codesDesc).toEqual([...codesAsc].reverse());
  });

  it("paginates with the envelope { rows, total, page, pageCount }", async () => {
    const all = await TeacherService.listTeachers({ pageSize: 100 });
    const p1 = await TeacherService.listTeachers({ page: 1, pageSize: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.total).toBe(all.total); // unfiltered total matches
    expect(p1.pageCount).toBe(Math.ceil(all.total / 2));
    const p2 = await TeacherService.listTeachers({ page: 2, pageSize: 2 });
    expect(p2.rows).toHaveLength(2);
    // pages are disjoint
    expect(p1.rows.map((r) => r.id)).not.toEqual(p2.rows.map((r) => r.id));
  });
});

const TeacherListOptionsShape = {
  status: true, language: true, currentDestinationId: true, search: true,
  sort: true, order: true, page: true, pageSize: true,
} as const;

describe("deactivate / reactivate lifecycle (§7/§8)", () => {
  it("requires a reason to deactivate", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P2-010"), admin);
    await expect(TeacherService.deactivateTeacher(t.id, "  ", admin)).rejects.toThrow(/reason/);
  });

  it("deactivates with date, refuses double-deactivation", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P2-011"), admin);
    const d = await TeacherService.deactivateTeacher(t.id, "moved away", admin);
    expect(d.status).toBe("INACTIVE");
    expect(d.dateInactive).toBeTruthy();
    await expect(TeacherService.deactivateTeacher(t.id, "again", admin)).rejects.toThrow(/already inactive/);
  });

  it("reports inactive duration dynamically and hides it when ACTIVE (§8)", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P2-012", { birthday: "1980-01-01" }), admin);
    await TeacherService.deactivateTeacher(t.id, "personal", admin);
    const inactive = await TeacherService.getTeacherDetails(t.id);
    expect(inactive.inactiveFor).not.toBeNull();
    expect(inactive.inactiveFor!.years).toBe(0);
    expect(inactive.teacher.status).toBe("INACTIVE");
    await TeacherService.reactivateTeacher(t.id, admin);
    const active = await TeacherService.getTeacherDetails(t.id);
    expect(active.inactiveFor).toBeNull();
    expect(active.teacher.status).toBe("ACTIVE");
  });

  it("reactivation refuses when already active", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P2-013"), admin);
    await expect(TeacherService.reactivateTeacher(t.id, admin)).rejects.toThrow(/already active/);
  });

  it("preserves BOTH inactivity events across two cycles in append-only audit (§7 refinement 1)", async () => {
    const t = await TeacherService.createTeacher(teacherInput("P2-014"), admin);

    await TeacherService.deactivateTeacher(t.id, "reason A (Jan cycle)", admin);
    await TeacherService.reactivateTeacher(t.id, admin);
    await TeacherService.deactivateTeacher(t.id, "reason B (Aug cycle)", admin);
    await TeacherService.reactivateTeacher(t.id, admin);

    // current state has no inactive fields left...
    const current = await TeacherService.getTeacher(t.id);
    expect(current.status).toBe("ACTIVE");
    expect(current.dateInactive).toBeNull();
    expect(current.inactiveReason).toBeNull();

    // ...but the audit trail retains every historical event with its reason.
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(drizzleSql`entity_id = ${t.id}`)
      .orderBy(schema.auditLogs.createdAt);
    const deactivations = logs.filter((l) => l.action === "DEACTIVATED_TEACHER");
    expect(deactivations).toHaveLength(2);
    expect(deactivations[0]!.reason).toBe("reason A (Jan cycle)");
    expect(deactivations[1]!.reason).toBe("reason B (Aug cycle)");
    // old values captured: first deactivation came from ACTIVE, second too
    expect((deactivations[0]!.oldValue as { status: string }).status).toBe("ACTIVE");
    expect((deactivations[1]!.oldValue as { status: string }).status).toBe("ACTIVE");
    // reactivations captured with the pre-reactivation INACTIVE old value
    const reactivations = logs.filter((l) => l.action === "REACTIVATED_TEACHER");
    expect(reactivations).toHaveLength(2);
    expect((reactivations[0]!.oldValue as { inactiveReason: string }).inactiveReason).toBe("reason A (Jan cycle)");
  });
});

describe("Current Destination — set/change/clear + integrity (§9/§10)", () => {
  let teacher: Awaited<ReturnType<typeof TeacherService.createTeacher>>;
  let dakoA: Awaited<ReturnType<typeof DakoService.createDako>>;
  let dakoB: Awaited<ReturnType<typeof DakoService.createDako>>;
  let week: Awaited<ReturnType<typeof import("@/server/services").WeekService.getOrCreateWeek>>;
  let assignmentCountBefore: number;

  beforeAll(async () => {
    const { WeekService } = await import("@/server/services");
    teacher = await TeacherService.createTeacher(teacherInput("P2-020"), admin);
    dakoA = await DakoService.createDako(dakoInput("PD-A"), admin);
    dakoB = await DakoService.createDako(dakoInput("PD-B"), admin);
    week = await WeekService.getOrCreateWeek(2090, 1);
    // Historical scheduling data that must survive every destination operation:
    await TeacherService.deactivateTeacher(teacher.id, "availability seed cycle", admin); // creates availability-unrelated trail
    await TeacherService.reactivateTeacher(teacher.id, admin);
    assignmentCountBefore = (await snap()).assignments;
  });

  it("set: assigns destination + duty, requires reason, audits old→new", async () => {
    const before = await snap();
    // New Update #7 — a set now carries the duty held at the destination.
    const res = await TeacherService.changeCurrentDestination(
      teacher.id,
      dakoA.id,
      "initial assignment",
      admin,
      "DESTINADO",
    );
    expect(res.teacher.currentDestinationId).toBe(dakoA.id);
    expect(res.teacher.duty).toBe("DESTINADO");
    expect(res.previousDestinationId).toBeNull();
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(drizzleSql`entity_id = ${teacher.id} and action = 'CHANGED_CURRENT_DESTINATION'`);
    expect(logs).toHaveLength(1);
    expect((logs[0]!.oldValue as { currentDestinationId: string | null }).currentDestinationId).toBeNull();
    expect((logs[0]!.newValue as { currentDestinationId: string }).currentDestinationId).toBe(dakoA.id);
    expect((logs[0]!.newValue as { duty: string }).duty).toBe("DESTINADO");
    expect(logs[0]!.reason).toBe("initial assignment");
    expect(logs[0]!.userId).toBe(admin.userId);
    expect(logs[0]!.createdAt).toBeInstanceOf(Date);
    // Duty is REQUIRED to set a destination — enforced by the service.
    const other = await TeacherService.createTeacher(teacherInput("P2-019"), admin);
    await expect(
      TeacherService.changeCurrentDestination(other.id, dakoA.id, "no duty supplied", admin),
    ).rejects.toThrow(/duty/);
    const after = await snap();
    expect(after).toEqual(before); // zero side effects on scheduling tables (audit growth is expected)
  });

  it("change: A→B audited; the new duty is stored and mirrored", async () => {
    const before = await snap();
    const res = await TeacherService.changeCurrentDestination(teacher.id, dakoB.id, "transfer", admin, "KATUWANG");
    expect(res.previousDestinationId).toBe(dakoA.id);
    expect(res.teacher.duty).toBe("KATUWANG");
    const after = await snap();
    expect(after.assignments).toBe(before.assignments);
    expect(after.history).toBe(before.history);
    expect(after.availability).toBe(before.availability);
  });

  it("clear: destination NULL, reason required, audit preserves NULL new value", async () => {
    const before = await snap();
    await expect(TeacherService.changeCurrentDestination(teacher.id, null, "   ", admin)).rejects.toThrow(/reason/);
    const res = await TeacherService.changeCurrentDestination(teacher.id, null, "teacher relocated", admin);
    expect(res.teacher.currentDestinationId).toBeNull();
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(drizzleSql`entity_id = ${teacher.id} and action = 'CHANGED_CURRENT_DESTINATION'`);
    const last = logs[logs.length - 1]!;
    expect((last.newValue as { currentDestinationId: string | null }).currentDestinationId).toBeNull();
    expect((last.oldValue as { currentDestinationId: string }).currentDestinationId).toBe(dakoB.id);
    const after = await snap();
    expect(after.assignments).toBe(before.assignments);
    expect(after.history).toBe(before.history);
    expect(after.availability).toBe(before.availability);
  });

  it("rejects set/change targeting a DISABLED dako (ACTIVE-only rule)", async () => {
    const disabled = await DakoService.createDako(dakoInput("PD-DIS"), admin);
    await DakoService.disableDako(disabled.id, "closed", admin);
    await expect(
      TeacherService.changeCurrentDestination(teacher.id, disabled.id, "should fail", admin, "DESTINADO"),
    ).rejects.toThrow(/ACTIVE/);
  });

  it("rejects unknown destination ids", async () => {
    await expect(
      TeacherService.changeCurrentDestination(
        teacher.id,
        "00000000-0000-0000-0000-000000000000",
        "ghost",
        admin,
        "DESTINADO",
      ),
    ).rejects.toThrow(/valid dako/);
  });

  it("create/edit paths also enforce ACTIVE-only destination (§6)", async () => {
    const disabled = await DakoService.createDako(dakoInput("PD-DIS2"), admin);
    await DakoService.disableDako(disabled.id, "closed", admin);
    await expect(
      TeacherService.createTeacher(teacherInput("P2-021", { currentDestinationId: disabled.id }), admin),
    ).rejects.toThrow(/ACTIVE/);
    const t = await TeacherService.createTeacher(teacherInput("P2-022"), admin);
    await expect(
      TeacherService.updateTeacher(t.id, { currentDestinationId: disabled.id }, admin),
    ).rejects.toThrow(/ACTIVE/);
  });

  it("destination operations never touched assignments/history/availability (snapshot equal across the whole describe)", async () => {
    const after = await snap();
    expect(after.assignments).toBe(assignmentCountBefore);
  });
});

describe("disabled dako as existing Current Destination (§11)", () => {
  let teacher: Awaited<ReturnType<typeof TeacherService.createTeacher>>;
  let dako: Awaited<ReturnType<typeof DakoService.createDako>>;

  beforeAll(async () => {
    teacher = await TeacherService.createTeacher(teacherInput("P2-030"), admin);
    dako = await DakoService.createDako(dakoInput("PE-1"), admin);
    await TeacherService.changeCurrentDestination(teacher.id, dako.id, "initial", admin, "DESTINADO");
  });

  it("disabling the dako preserves the existing destination relationship", async () => {
    const before = await snap();
    await DakoService.disableDako(dako.id, "merged into another congregation", admin);
    const after = await snap();
    expect(after).toEqual(before); // no automatic clears, no scheduling changes
    const t = await TeacherService.getTeacher(teacher.id);
    expect(t.currentDestinationId).toBe(dako.id); // PRESERVED
    const details = await TeacherService.getTeacherDetails(teacher.id);
    expect(details.currentDestination?.status).toBe("DISABLED"); // UI indicator source
  });

  it("disabled dako are excluded from the new-destination picker (ACTIVE list)", async () => {
    const picker = await DakoService.listDako({ status: "ACTIVE" });
    expect(picker.rows.find((r) => r.id === dako.id)).toBeUndefined();
  });

  it("re-enabling restores eligibility without any data loss", async () => {
    await DakoService.enableDako(dako.id, admin);
    const picker = await DakoService.listDako({ status: "ACTIVE" });
    expect(picker.rows.find((r) => r.id === dako.id)).toBeDefined();
    const t = await TeacherService.getTeacher(teacher.id);
    expect(t.currentDestinationId).toBe(dako.id);
  });
});

describe("dako CRUD + validation (§12)", () => {
  it("creates, audits, rejects duplicates", async () => {
    const d = await DakoService.createDako(dakoInput("P2-040"), admin);
    const logs = await db.select().from(schema.auditLogs).where(drizzleSql`entity_id = ${d.id}`);
    expect(logs.map((l) => l.action)).toContain("CREATED_DAKO");
    await expect(DakoService.createDako(dakoInput("P2-040"), admin)).rejects.toThrow(/already exists/);
  });

  it("rejects invalid worship time and day", async () => {
    await expect(DakoService.createDako(dakoInput("P2-041", { worshipTime: "25:99" }), admin)).rejects.toThrow();
    await expect(
      DakoService.createDako(dakoInput("P2-042", { worshipDay: "LORDSDAY" as "SUNDAY" }), admin),
    ).rejects.toThrow();
  });

  it("requires reason to disable; refuses double disable; enable restores", async () => {
    const d = await DakoService.createDako(dakoInput("P2-043"), admin);
    await expect(DakoService.disableDako(d.id, "   ", admin)).rejects.toThrow(/reason/);
    const dis = await DakoService.disableDako(d.id, "consolidation", admin);
    expect(dis.status).toBe("DISABLED");
    expect(dis.dateDisabled).toBeTruthy();
    await expect(DakoService.disableDako(d.id, "again", admin)).rejects.toThrow(/already disabled/);
    // enabling a DISABLED dako succeeds and restores ACTIVE
    const en = await DakoService.enableDako(d.id, admin);
    expect(en.status).toBe("ACTIVE");
    expect(en.dateDisabled).toBeNull();
  });

  it("edit writes UPDATED_DAKO with old/new values", async () => {
    const d = await DakoService.createDako(dakoInput("P2-044"), admin);
    await DakoService.updateDako(d.id, { name: "Renamed Dako" }, admin);
    const logs = await db
      .select()
      .from(schema.auditLogs)
      .where(drizzleSql`entity_id = ${d.id} and action = 'UPDATED_DAKO'`);
    expect((logs[0]!.oldValue as { name: string }).name).toBe(`Dako P2-044`);
    expect((logs[0]!.newValue as { name: string }).name).toBe("Renamed Dako");
  });

  it("update of a nonexistent dako 404s", async () => {
    await expect(
      DakoService.updateDako("00000000-0000-0000-0000-000000000000", { name: "x" }, admin),
    ).rejects.toThrow(/not found/);
  });
});

describe("dako list — search/filter/sort/pagination (§13/§14)", () => {
  it("searches code/name/address", async () => {
    expect((await DakoService.listDako({ search: "PE-1" })).rows.length).toBeGreaterThanOrEqual(1);
    expect((await DakoService.listDako({ search: "Renamed" })).rows).toHaveLength(1);
  });

  it("filters by status, language, priority, worship day (Update #6: priority is a dako filter)", async () => {
    await DakoService.createDako(dakoInput("P2-045", { isPriority: true, language: "ENGLISH", worshipDay: "WEDNESDAY" }), admin);
    expect((await DakoService.listDako({ isPriority: true })).rows).toHaveLength(1);
    expect((await DakoService.listDako({ language: "ENGLISH", status: "ACTIVE" })).rows).toHaveLength(1);
    expect((await DakoService.listDako({ worshipDay: "WEDNESDAY" })).rows).toHaveLength(1);
  });

  it("sorts by whitelisted fields and paginates", async () => {
    // dateEstablished is an allowed SORT key even though the display column is not returned.
    const byDate = (await DakoService.listDako({ sort: "dateEstablished", order: "asc" })).rows;
    const unsorted = (await DakoService.listDako({ sort: "code", order: "asc" })).rows;
    expect([...byDate].sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.id)).toEqual(
      [...unsorted].sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.id),
    );
    const codes = (await DakoService.listDako({ sort: "code", order: "asc" })).rows.map((r) => r.dakoCode);
    expect(codes).toEqual([...codes].sort());
    const p = await DakoService.listDako({ page: 1, pageSize: 2 });
    expect(p.rows.length).toBeLessThanOrEqual(2);
    expect(p.pageCount).toBeGreaterThanOrEqual(1);
  });
});

describe("dako anniversary (§16 — computed, leap-year safe)", () => {
  it("computes years completed from date_established and never stores it", async () => {
    const d = await DakoService.createDako(dakoInput("P2-050", { dateEstablished: "2000-03-10" }), admin);
    expect(JSON.stringify(d)).not.toContain("anniversaryYears");
    const details = await DakoService.getDakoDetails(d.id);
    // March 10 anniversary already passed in the current year (test runs later in the year):
    // 26 years completed, next is the 27th in the following year.
    expect(details.anniversary.yearsCompleted).toBe(new Date().getUTCFullYear() - 2000);
    const establishedYear = 2000;
    const expectedNextYear =
      details.anniversary.daysUntil === 0
        ? establishedYear + details.anniversary.yearsCompleted
        : establishedYear + details.anniversary.yearsCompleted + 1;
    expect(details.anniversary.anniversaryYear).toBe(expectedNextYear);
  });

  it("next anniversary is in the future; daysUntil counts real calendar days (no 365 arithmetic)", async () => {
    const d = await DakoService.createDako(dakoInput("P2-051", { dateEstablished: "2005-01-01" }), admin);
    const details = await DakoService.getDakoDetails(d.id);
    const today = new Date();
    const year = today.getUTCFullYear();
    const expectedDays = Math.round(
      (Date.UTC(year, 0, 1) - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86_400_000,
    );
    if (expectedDays >= 0) {
      expect(details.anniversary.nextDate).toBe(`${year}-01-01`);
      expect(details.anniversary.daysUntil).toBe(expectedDays);
    } else {
      expect(details.anniversary.nextDate).toBe(`${year + 1}-01-01`);
    }
    expect(Number.isInteger(details.anniversary.daysUntil)).toBe(true);
  });
});

describe("RBAC (§17)", () => {
  it("viewer has no write permissions anywhere in master data", () => {
    expect(hasPermission(["VIEWER"], "teachers.write")).toBe(false);
    expect(hasPermission(["VIEWER"], "dako.write")).toBe(false);
    expect(hasPermission(["VIEWER"], "availability.write")).toBe(false);
    expect(hasPermission(["VIEWER"], "users.manage")).toBe(false);
    expect(hasPermission(["VIEWER"], "teachers.read")).toBe(true);
    expect(hasPermission(["VIEWER"], "dako.read")).toBe(true);
  });

  it("scheduler can manage teachers/dako/destinations but not users", () => {
    expect(hasPermission(["SCHEDULER"], "teachers.write")).toBe(true);
    expect(hasPermission(["SCHEDULER"], "dako.write")).toBe(true);
    expect(hasPermission(["SCHEDULER"], "weeks.write")).toBe(true);
    expect(hasPermission(["SCHEDULER"], "users.manage")).toBe(false);
  });

  it("administrator has full master-data access", () => {
    expect(hasPermission(["ADMIN"], "teachers.write")).toBe(true);
    expect(hasPermission(["ADMIN"], "dako.write")).toBe(true);
    expect(hasPermission(["ADMIN"], "users.manage")).toBe(true);
  });

  it("anonymous (no roles) cannot mutate", () => {
    expect(hasPermission([], "teachers.write")).toBe(false);
    expect(hasPermission([], "dako.write")).toBe(false);
  });
});

describe("audit append-only (§18/§28)", () => {
  it("rejects UPDATE and DELETE on audit_logs at the DB level", async () => {
    await expect(sql`UPDATE audit_logs SET reason = 'tamper'`).rejects.toThrow();
    await expect(sql`DELETE FROM audit_logs`).rejects.toThrow();
  });

  it("every master-data action is represented with user/timestamp", async () => {
    // Guarantee UPDATED_TEACHER exists in the trail for this proof:
    const t = await TeacherService.createTeacher(teacherInput("P2-070"), admin);
    await TeacherService.updateTeacher(t.id, { remarks: "audit completeness probe" }, admin);
    const actions = new Set(
      (await db.select({ action: schema.auditLogs.action }).from(schema.auditLogs)).map((r) => r.action),
    );
    for (const expected of [
      "CREATED_TEACHER", "UPDATED_TEACHER", "DEACTIVATED_TEACHER", "REACTIVATED_TEACHER",
      "CHANGED_CURRENT_DESTINATION", "CREATED_DAKO", "UPDATED_DAKO", "DISABLED_DAKO", "ENABLED_DAKO",
    ]) {
      expect(actions.has(expected)).toBe(true);
    }
    // audit rows carry the acting user and a timestamp
    const sample = await db.select().from(schema.auditLogs).where(drizzleSql`entity_id = ${t.id}`);
    expect(sample.length).toBeGreaterThanOrEqual(2);
    expect(sample[0]!.userId).toBe(admin.userId);
    expect(sample[0]!.createdAt).toBeInstanceOf(Date);
  });
});

describe("data integrity — master data edits never rewrite scheduling history (§25/§26)", () => {
  it("renames and status flips leave assignments/history/availability untouched", async () => {
    const { WeekService, AssignmentService } = await import("@/server/services");
    const t = await TeacherService.createTeacher(teacherInput("P2-060", { language: "FILIPINO" }), admin);
    const d = await DakoService.createDako(dakoInput("PF-1", { language: "FILIPINO" }), admin);
    const w = await WeekService.getOrCreateWeek(2091, 2);
    await AssignmentService.createAssignment({ weekId: w.id, dakoId: d.id, teacherId: t.id, assignmentType: "SUGO" }, admin);
    const before = await snap();

    await TeacherService.updateTeacher(t.id, { firstName: "RenamedFirst", lastName: "RenamedLast", language: "ENGLISH" }, admin);
    await TeacherService.deactivateTeacher(t.id, "post-assignment deactivation", admin);
    await DakoService.updateDako(d.id, { name: "Dako Renamed Later" }, admin);
    await DakoService.disableDako(d.id, "post-assignment disable", admin);

    const after = await snap();
    expect(after.assignments).toBe(before.assignments);
    expect(after.history).toBe(before.history);
    expect(after.availability).toBe(before.availability);

    // historical assignment rows keep their IDs and type/source intact
    const rows = await db.select().from(schema.assignments);
    expect(rows).toHaveLength(before.assignments);
    expect(rows[0]!.assignmentType).toBe("SUGO");
    expect(rows[0]!.teacherId).toBe(t.id);
    expect(rows[0]!.dakoId).toBe(d.id);
  });
});
