/**
 * Phase 5 — NON-OVERRIDABLE language rule regression suite (§14/§24).
 * Proves the absolute rule across every assignment path:
 *   FIL teacher → EN dako is impossible for Scheduler, ADMIN (with or without
 *   override reason), changeAssignment, and the raw API (POST + PATCH), and
 *   eligibility-check reports LANGUAGE_MISMATCH with overrideAllowed=false.
 * Valid combinations are preserved: EN→EN, EN→FIL, FIL→FIL succeed.
 */
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db, sql } from "./helpers";
import * as schema from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/session";

function actor(userId: string, roles: string[]): SessionUser {
  return { userId, email: "x@test.local", fullName: "X", mustChangePassword: false, roleCodes: roles, permissions: [] };
}

const PORT = process.env.PNK_TEST_PORT ?? "5434";
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_COOKIE = "pnk_admin_cookie";
const SCHED_COOKIE = "pnk_sched_cookie";

/** Seed a user + session cookie directly in the test DB for API-level tests. */
async function seedSession(userId: string, cookie: string): Promise<void> {
  const token = `tok_${cookie}`;
  await db.insert(schema.sessions).values({
    userId,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  if (cookie === ADMIN_COOKIE) (globalThis as Record<string, unknown>).__adminTok = token;
  else (globalThis as Record<string, unknown>).__schedTok = token;
}

async function apiCall(
  method: string,
  path: string,
  body: unknown,
  tok: string,
): Promise<Response> {
  const base = API_BASE ?? BASE;
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: `pnk_session=${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// The API tests need a running app; they are skipped unless PNK_API_TEST_URL is set.
const API_BASE = process.env.PNK_API_TEST_URL;
const api = API_BASE ? it : it.skip;
function apiTok(which: "admin" | "sched"): string {
  const g = globalThis as Record<string, unknown>;
  return String(which === "admin" ? g.__adminTok : g.__schedTok);
}

describe("Phase 5 language rule (non-overrideable)", () => {
  let adminId: string;
  let schedId: string;

  beforeAll(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
    schedId = await seedScheduler();
    await seedSession(adminId, ADMIN_COOKIE);
    await seedSession(schedId, SCHED_COOKIE);
  });
  afterAll(async () => { await teardown(); });

  const admin = () => actor(adminId, ["ADMIN"]);
  const sched = () => actor(schedId, ["SCHEDULER"]);

  /** Unique-per-test fixture universe (shared DB — codes/weeks must never collide). */
  let fixtureSeq = 0;
  async function fixture() {
    const s = ++fixtureSeq;
    const mkT = async (code: string, language: string) =>
      (await db.insert(schema.teachers).values({ teacherCode: code, firstName: "T", lastName: code, language }).returning())[0]!;
    const mkD = async (code: string, language: string) =>
      (await db.insert(schema.dako).values({ dakoCode: code, name: `Dako ${code}`, address: "a", dateEstablished: "2000-01-01", worshipDay: "SUNDAY", worshipTime: "09:00", language }).returning())[0]!;
    const fil = await mkT(`LG-F${s}`, "FILIPINO");
    const eng = await mkT(`LG-E${s}`, "ENGLISH");
    const engDako = await mkD(`LGD-E${s}`, "ENGLISH");
    const filDako = await mkD(`LGD-F${s}`, "FILIPINO");
    const week = (await db.insert(schema.weeks).values({ year: 2080 + s, isoWeekNumber: 1, startDate: "2098-12-28", endDate: "2099-01-03", status: "DRAFT" }).returning())[0]!;
    const avail = async (teacherId: string) =>
      db.insert(schema.teacherAvailability).values({ teacherId, weekId: week.id, availabilityStatus: "AVAILABLE" });
    await avail(fil.id); await avail(eng.id);
    return { fil, eng, engDako, filDako, week, s };
  }

  it("1. Scheduler cannot assign Filipino teacher to English dako", async () => {
    const { fil, engDako, week } = await fixture();
    const { AssignmentService } = await import("@/server/services");
    await expect(
      AssignmentService.createAssignment({ weekId: week.id, dakoId: engDako.id, teacherId: fil.id, assignmentType: "SUGO" }, sched()),
    ).rejects.toThrow(/cannot serve/);
  });

  it("2. ADMIN cannot assign Filipino teacher to English dako even with an override reason", async () => {
    const { fil, engDako, week } = await fixture();
    const { AssignmentService } = await import("@/server/services");
    await expect(
      AssignmentService.createAssignment(
        { weekId: week.id, dakoId: engDako.id, teacherId: fil.id, assignmentType: "SUGO", overrideReason: "desperate need" },
        admin(),
      ),
    ).rejects.toThrow(/not overridable/);
  });

  it("3. ADMIN cannot change an assignment to a Filipino teacher on an English dako", async () => {
    const { fil, eng, engDako, week, s } = await fixture();
    const { AssignmentService } = await import("@/server/services");
    const a = await AssignmentService.createAssignment({ weekId: week.id, dakoId: engDako.id, teacherId: eng.id, assignmentType: "SUGO" }, admin());
    await expect(
      AssignmentService.changeAssignment(a.assignment.id, { teacherId: fil.id, reason: "swap" }, admin()),
    ).rejects.toThrow(/non-overrideable/);
    // English swap still allowed (rule not over-broadened)
    const eng2 = (await db.insert(schema.teachers).values({ teacherCode: `LG-E2${s}`, firstName: "T", lastName: "E2", language: "ENGLISH" }).returning())[0]!;
    await db.insert(schema.teacherAvailability).values({ teacherId: eng2.id, weekId: week.id, availabilityStatus: "AVAILABLE" });
    await AssignmentService.changeAssignment(a.assignment.id, { teacherId: eng2.id, reason: "swap" }, admin());
  });

  it("4. eligibility-check returns LANGUAGE_MISMATCH with overrideAllowed=false", async () => {
    const { fil, engDako, week } = await fixture();
    const { SchedulingService } = await import("@/server/services");
    const r = await SchedulingService.checkEligibility({ weekId: week.id, dakoId: engDako.id, teacherId: fil.id });
    expect(r.eligible).toBe(false);
    expect(r.violatedRules).toContain("LANGUAGE_MISMATCH");
    expect(r.overrideAllowed).toBe(false);
  });

  it("5. API-level bypass is rejected (POST and PATCH)", async () => {
    if (!API_BASE) return; // skipped unless API tests are enabled
    const { fil, eng, engDako, week } = await fixture();
    const adminTok = apiTok("admin");
    const post = await apiCall("POST", "/api/assignments", { weekId: week.id, dakoId: engDako.id, teacherId: fil.id, assignmentType: "SUGO", overrideReason: "api attempt" }, adminTok);
    expect(post.status).toBe(409);
    const created = await db.select().from(schema.assignments).where(eq(schema.assignments.weekId, week.id));
    expect(created.length).toBe(0);
    // seed a valid EN assignment then attempt the FIL PATCH
    void eng;
  });

  api("5b. API PATCH to FIL teacher on EN dako rejected", async () => {
    const { fil, eng, engDako, week } = await fixture();
    const adminTok = apiTok("admin");
    const post = await apiCall("POST", "/api/assignments", { weekId: week.id, dakoId: engDako.id, teacherId: eng.id, assignmentType: "SUGO" }, adminTok);
    expect(post.status).toBe(201);
    const { id } = (await post.json()).data.assignment;
    const patch = await apiCall("PATCH", `/api/assignments/${id}`, { teacherId: fil.id, reason: "api attempt" }, adminTok);
    expect(patch.status).toBe(409);
  });

  it("6. English teacher → English dako succeeds", async () => {
    const { eng, engDako, week } = await fixture();
    const { AssignmentService } = await import("@/server/services");
    const res = await AssignmentService.createAssignment({ weekId: week.id, dakoId: engDako.id, teacherId: eng.id, assignmentType: "SUGO" }, sched());
    expect(res.assignment.assignmentSource).toBe("MANUAL");
  });

  it("7. English teacher → Filipino dako succeeds", async () => {
    const { eng, filDako, week } = await fixture();
    const { AssignmentService } = await import("@/server/services");
    const res = await AssignmentService.createAssignment({ weekId: week.id, dakoId: filDako.id, teacherId: eng.id, assignmentType: "SUGO" }, sched());
    expect(res.assignment.teacherId).toBe(eng.id);
  });

  it("8. Filipino teacher → Filipino dako succeeds", async () => {
    const { fil, filDako, week } = await fixture();
    const { AssignmentService } = await import("@/server/services");
    const res = await AssignmentService.createAssignment({ weekId: week.id, dakoId: filDako.id, teacherId: fil.id, assignmentType: "SUGO" }, sched());
    expect(res.assignment.teacherId).toBe(fil.id);
  });

  it("9. Filipino teacher → English dako fails (engine path too)", async () => {
    const { fil, engDako, week } = await fixture();
    const { SchedulingService } = await import("@/server/services");
    const plan = await SchedulingService.previewSchedule(week.id);
    const engSugo = plan.slots.find((s) => s.dakoId === engDako.id && s.assignmentType === "SUGO");
    expect(engSugo?.teacherId ?? null).not.toBe(fil.id);
    if (engSugo?.teacherId) expect(engSugo.teacherId).not.toBe(fil.id);
    else expect(engSugo?.reasonCode).toBe("LANGUAGE_MISMATCH");
  });

  it("bonus: ADMIN cannot override onto a DISABLED dako (gap closed)", async () => {
    const { fil, eng, engDako, week } = await fixture();
    const { DakoService, AssignmentService } = await import("@/server/services");
    await DakoService.disableDako(engDako.id, "closed", admin());
    await expect(
      AssignmentService.createAssignment({ weekId: week.id, dakoId: engDako.id, teacherId: eng.id, assignmentType: "SUGO" }, sched()),
    ).rejects.toThrow(/DISABLED/);
    await expect(
      AssignmentService.createAssignment({ weekId: week.id, dakoId: engDako.id, teacherId: fil.id, assignmentType: "SUGO", overrideReason: "try" }, admin()),
    ).rejects.toThrow(/DISABLED/);
    void fil;
  });
});
