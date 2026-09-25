/**
 * Update #22 — WEEKLY AVAILABILITY PREREQUISITE, on the wire.
 *
 * The generation endpoints must never generate (or persist anything) until the
 * SELECTED ISO week's required availability is encoded. This suite drives the
 * REAL route handlers with the REAL services and database behind them
 * (`requirePermission` reads the session through `next/headers`, so only
 * `cookies()` is mocked, exactly like the Create User route suite).
 *
 * Pinned here:
 *   1. A blocked attempt answers 422 AVAILABILITY_REQUIRED with the blocking
 *      sentence, generates NOTHING, creates NO assignments, and is audited
 *      (GENERATION_BLOCKED with week/year, method and validation result).
 *      For `{ year, week }` it must not even create the week row.
 *   2. The same gate covers all three generating methods plus the gate-only
 *      `manual` mode (which persists nothing even when the gate passes).
 *   3. The gate probe (GET /api/scheduling/generation-gate) is READ-ONLY: an
 *      incomplete probe blocks and audits without creating a week row.
 *   4. The SELECTED week is the week generated — Week 1, Week 52 and Week 53
 *      (when the year has one), with the ISO year preserved; an impossible week
 *      number is rejected.
 *   5. RBAC is unchanged: anonymous 401, VIEWER 403, before any body work.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { resetTestDb, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import { createSession, SESSION_COOKIE, type SessionUser } from "@/server/auth/session";
import { AvailabilityService, DakoService, TeacherService, WeekService } from "@/server/services";
import { isoWeeksInYear } from "@/lib/iso-week";

import { POST as generatePost } from "@/app/api/scheduling/generate/route";
import { GET as gateGet } from "@/app/api/scheduling/generation-gate/route";

const auth = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      auth.token !== undefined && name === SESSION_COOKIE ? { name, value: auth.token } : undefined,
  }),
}));

/** A far-future ISO year/week: comfortably after the scheduling go-live. */
const YEAR = 2031;
const WEEK = 20;

function sessionUser(userId: string, roles: string[]): SessionUser {
  return {
    userId,
    email: "gate@test.local",
    fullName: "Gate Tester",
    mustChangePassword: false,
    roleCodes: roles,
    permissions: [],
  };
}

async function makeSession(role: "ADMIN" | "SCHEDULER" | "VIEWER") {
  const inserted = await db
    .insert(schema.users)
    .values({ email: `${role.toLowerCase()}-gate@test.local`, fullName: `${role} Gate`, passwordHash: "x" })
    .returning();
  const userId = inserted[0]!.id;
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, role));
  await db.insert(schema.userRoles).values({ userId, roleId: roleRows[0]!.id });
  const { token } = await createSession(userId);
  return { token, userId };
}

function post(body: unknown): Promise<Response> {
  return generatePost(
    new Request("http://localhost:3000/api/scheduling/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function gate(query: string): Promise<Response> {
  return gateGet(new Request(`http://localhost:3000/api/scheduling/generation-gate?${query}`));
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type ErrBody = { code?: string; message?: string };
const errorOf = (body: Record<string, unknown>): ErrBody => (body.error ?? {}) as ErrBody;

let adminToken: string;
let adminId: string;
let viewerToken: string;
let dakoId: string;
let teacherIds: string[];

/** One ACTIVE dako + two ACTIVE duty teachers; NO availability encoded. */
async function setupBase() {
  await resetTestDb();
  const admin = await makeSession("ADMIN");
  adminToken = admin.token;
  adminId = admin.userId;
  viewerToken = (await makeSession("VIEWER")).token;

  const dako = await DakoService.createDako(
    {
      dakoCode: "GATE-D",
      name: "Gate Dako",
      address: "1 Gate St",
      dateEstablished: "2001-06-15",
      worshipDay: "SUNDAY",
      worshipTime: "09:00",
      language: "FILIPINO",
    },
    sessionUser(adminId, ["ADMIN"]),
  );
  dakoId = dako.id;

  const roster = [
    { code: "GATE-A", duty: "DESTINADO" as const },
    { code: "GATE-B", duty: "KATUWANG" as const },
  ];
  teacherIds = [];
  for (const t of roster) {
    const created = await TeacherService.createTeacher(
      {
        teacherCode: t.code,
        firstName: "Gate",
        lastName: t.code,
        language: "FILIPINO",
        duty: t.duty,
        currentDestinationId: dakoId,
      } as Parameters<typeof TeacherService.createTeacher>[0],
      sessionUser(adminId, ["ADMIN"]),
    );
    teacherIds.push(created.id);
  }
  auth.token = adminToken; // armed before the first test
}

/** Complete required availability for one week (all ACTIVE teachers). */
async function seedAvailability(weekId: string) {
  for (const id of teacherIds) {
    await db
      .insert(schema.teacherAvailability)
      .values({ teacherId: id, weekId, availabilityStatus: "AVAILABLE" });
  }
}

async function weekRow(year: number, week: number) {
  const rows = await db
    .select()
    .from(schema.weeks)
    .where(and(eq(schema.weeks.year, year), eq(schema.weeks.isoWeekNumber, week)));
  return rows[0] ?? null;
}

async function assignmentsFor(weekId: string) {
  return db.select().from(schema.assignments).where(eq(schema.assignments.weekId, weekId));
}

async function blockedAudits() {
  return db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "GENERATION_BLOCKED"));
}

beforeEach(setupBase);

afterAll(async () => {
  await teardown();
});

describe("Update #22 — POST /api/scheduling/generate availability gate", () => {
  it("blocks generation, audits the attempt, and creates neither a week nor assignments", async () => {
    const res = await post({ year: YEAR, week: WEEK, mode: "auto" });
    expect(res.status).toBe(422);
    const body = await bodyOf(res);
    expect(errorOf(body).code).toBe("AVAILABILITY_REQUIRED");
    expect(errorOf(body).message).toMatch(/Weekly Availability has not been set/);
    expect(errorOf(body).message).toContain(`ISO Week ${WEEK}, ${YEAR}`);
    expect(errorOf(body).message).toMatch(/Please set the teacher availability before generating the Suguan/);

    // Nothing persisted — not even the week row (the gate runs first).
    expect(await weekRow(YEAR, WEEK)).toBeNull();
    const audits = await blockedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.newValue).toMatchObject({
      week: { year: YEAR, isoWeekNumber: WEEK },
      generationMode: "auto",
      validation: { result: "BLOCKED", rule: "WEEKLY_AVAILABILITY_REQUIRED", missing: 2, total: 2 },
    });
  });

  it("applies to every generating method — auto, destinado and katuwang", async () => {
    for (const mode of ["auto", "destinado", "katuwang"]) {
      const res = await post({ year: YEAR, week: WEEK, mode });
      expect(res.status, mode).toBe(422);
      expect(errorOf(await bodyOf(res)).code, mode).toBe("AVAILABILITY_REQUIRED");
    }
    expect(await weekRow(YEAR, WEEK)).toBeNull();
  });

  it("generates the SELECTED week once its availability is complete", async () => {
    const week = await WeekService.resolveWeek({ year: YEAR, week: WEEK });
    await seedAvailability(week.id);

    const res = await post({ year: YEAR, week: WEEK, mode: "auto" });
    expect(res.status).toBe(201);
    const data = (await bodyOf(res)).data as { inserted: number; weekId: string };
    expect(data.weekId).toBe(week.id);
    expect(data.inserted).toBeGreaterThan(0);

    const rows = await assignmentsFor(week.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.weekId === week.id)).toBe(true);

    // The successful run is audited through the existing generation audit, and
    // no block was recorded.
    const generated = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "GENERATED_SCHEDULE"));
    expect(generated.length).toBe(1);
    expect(await blockedAudits()).toHaveLength(0);
  });

  it("gates a { weekId } request too (the Weekly Schedule entry point)", async () => {
    const week = await WeekService.resolveWeek({ year: YEAR, week: WEEK });
    const blocked = await post({ weekId: week.id, mode: "auto" });
    expect(blocked.status).toBe(422);
    expect(errorOf(await bodyOf(blocked)).code).toBe("AVAILABILITY_REQUIRED");

    await seedAvailability(week.id);
    const okRes = await post({ weekId: week.id, mode: "katuwang" });
    expect(okRes.status).toBe(201);
    expect((await assignmentsFor(week.id)).length).toBeGreaterThan(0);
  });

  it("treats manual as gate-only: blocked without availability, nothing persisted when allowed", async () => {
    const blocked = await post({ year: YEAR, week: WEEK, mode: "manual" });
    expect(blocked.status).toBe(422);
    expect(errorOf(await bodyOf(blocked)).code).toBe("AVAILABILITY_REQUIRED");
    expect(await weekRow(YEAR, WEEK)).toBeNull();

    const week = await WeekService.resolveWeek({ year: YEAR, week: WEEK });
    await seedAvailability(week.id);
    const res = await post({ year: YEAR, week: WEEK, mode: "manual" });
    expect(res.status).toBe(200);
    const data = (await bodyOf(res)).data as { manual?: boolean; weekId?: string };
    expect(data.manual).toBe(true);
    expect(data.weekId).toBe(week.id);
    expect(await assignmentsFor(week.id)).toHaveLength(0);
  });

  it("rejects an unknown generation mode (contract unchanged)", async () => {
    const res = await post({ year: YEAR, week: WEEK, mode: "wishful" });
    expect(res.status).toBe(422);
    expect(errorOf(await bodyOf(res)).code).toBe("VALIDATION_ERROR");
  });
});

describe("Update #22 — selected ISO week targeting", () => {
  async function generateFor(year: number, weekNumber: number) {
    const row = await WeekService.resolveWeek({ year, week: weekNumber });
    await seedAvailability(row.id);
    const res = await post({ year, week: weekNumber, mode: "auto" });
    expect(res.status, `${year}-W${weekNumber}`).toBe(201);
    const rows = await assignmentsFor(row.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.weekId === row.id)).toBe(true);
    return row;
  }

  it("targets Week 1, Week 52 and Week 53 (when the year has one), preserving the ISO year", async () => {
    // Blocked first — the message names the SELECTED week, not the browser's week.
    const blockedW1 = await post({ year: YEAR, week: 1, mode: "auto" });
    expect(errorOf(await bodyOf(blockedW1)).message).toContain(`ISO Week 1, ${YEAR}`);

    await generateFor(YEAR, 1);
    await generateFor(YEAR, 52);

    const yearWith53 = [2026, 2032, 2037, 2043].find((y) => isoWeeksInYear(y) === 53);
    expect(yearWith53).toBeDefined();
    const blockedW53 = await post({ year: yearWith53!, week: 53, mode: "auto" });
    expect(blockedW53.status).toBe(422);
    expect(errorOf(await bodyOf(blockedW53)).message).toContain(`ISO Week 53, ${yearWith53}`);
    const generated = await generateFor(yearWith53!, 53);
    expect(generated.year).toBe(yearWith53);
    expect(generated.isoWeekNumber).toBe(53);
  });

  it("rejects a week number the ISO year does not have (Week 53 of a 52-week year)", async () => {
    const weeksIn2031 = isoWeeksInYear(YEAR);
    expect(weeksIn2031).toBe(52);
    const res = await post({ year: YEAR, week: 53, mode: "auto" });
    expect(res.status).toBe(422);
    expect(errorOf(await bodyOf(res)).message).toMatch(/has only 52 ISO weeks/);
    expect(await weekRow(YEAR, 53)).toBeNull();
  });
});

describe("Update #22 — GET /api/scheduling/generation-gate", () => {
  it("is read-only: blocks, audits, and never creates the week row", async () => {
    const res = await gate(`year=${YEAR}&week=${WEEK}&mode=manual`);
    expect(res.status).toBe(422);
    expect(errorOf(await bodyOf(res)).code).toBe("AVAILABILITY_REQUIRED");
    expect(await weekRow(YEAR, WEEK)).toBeNull();
    const audits = await blockedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.newValue).toMatchObject({ generationMode: "manual" });
  });

  it("reports readiness once availability is complete (by year/week and by weekId)", async () => {
    const week = await WeekService.resolveWeek({ year: YEAR, week: WEEK });
    const before = await gate(`year=${YEAR}&week=${WEEK}`);
    expect(before.status).toBe(422);

    await seedAvailability(week.id);
    const ready = await gate(`year=${YEAR}&week=${WEEK}`);
    expect(ready.status).toBe(200);
    expect((await bodyOf(ready)).data).toMatchObject({
      ready: true,
      missing: 0,
      total: 2,
      year: YEAR,
      week: WEEK,
      weekId: week.id,
    });

    const byId = await gate(`weekId=${week.id}`);
    expect(byId.status).toBe(200);
    expect((await bodyOf(byId)).data).toMatchObject({ ready: true, weekId: week.id });
  });

  it("404s an unknown weekId and 400s a malformed query", async () => {
    const missing = await gate("weekId=00000000-0000-4000-8000-000000000000");
    expect(missing.status).toBe(404);

    const malformed = await gate(`year=${YEAR}`);
    expect(malformed.status).toBe(400);
  });
});

describe("Update #24 — the fix-availability guide's numbers are the gate's numbers", () => {
  it("agrees with the gate and Fill Blanks, and filling is exactly what clears the block", async () => {
    const week = await WeekService.resolveWeek({ year: YEAR, week: WEEK });
    const readiness = await AvailabilityService.getWeeklyAvailabilityReadiness({ weekId: week.id });
    const fillTargets = await AvailabilityService.countFillBlankTargets(week.id);
    const active = await db.select().from(schema.teachers).where(eq(schema.teachers.status, "ACTIVE"));

    // The guide highlights exactly the rows Fill Blanks targets, over exactly
    // the teachers the gate requires, and repeats the gate's own sentence — so
    // the page can never promise something the server would not enforce.
    expect(readiness.total).toBe(active.length);
    expect(readiness.missing).toBe(fillTargets);
    expect(readiness.ready).toBe(false);
    expect(readiness.message).toContain(`ISO Week ${WEEK}, ${YEAR}`);
    expect(readiness.message).toMatch(/Please set the teacher availability before generating the Suguan/);

    const created = await AvailabilityService.fillBlanksAsAvailable(week.id, sessionUser(adminId, ["ADMIN"]));
    expect(created.created).toBe(fillTargets);

    const after = await AvailabilityService.getWeeklyAvailabilityReadiness({ weekId: week.id });
    expect(after.ready).toBe(true);
    expect(after.message).toBeNull();
    expect(await AvailabilityService.countFillBlankTargets(week.id)).toBe(0);
    // …and the gate now lets generation through — no second rule to satisfy.
    expect((await post({ year: YEAR, week: WEEK, mode: "auto" })).status).toBe(201);
  });
});

describe("Update #22 — RBAC unchanged", () => {
  it("blocks anonymous callers with 401 and VIEWER with 403, before any body work", async () => {
    auth.token = undefined;
    expect((await post({ year: YEAR, week: WEEK, mode: "auto" })).status).toBe(401);
    expect((await gate(`year=${YEAR}&week=${WEEK}`)).status).toBe(401);

    auth.token = viewerToken;
    expect((await post({ year: YEAR, week: WEEK, mode: "auto" })).status).toBe(403);
    expect((await gate(`year=${YEAR}&week=${WEEK}`)).status).toBe(403);
    expect(await blockedAudits()).toHaveLength(0);

    auth.token = adminToken;
  });
});
