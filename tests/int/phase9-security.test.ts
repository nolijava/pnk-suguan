/**
 * Phase 9 — security hardening tests.
 *
 * 1. ANONYMOUS SWEEP: every guarded API route export (all HTTP methods)
 *    must reject an unauthenticated request with a non-2xx status — no
 *    handler may ever complete without authentication.
 * 2. fail() SANITIZATION: unexpected (non-AppError) errors produce a fixed
 *    generic 500 body; AppError messages are preserved; nothing leaks.
 * 3. LOGIN THROTTLING: exponential per-account + per-IP backoff, reset on
 *    success, uniform "Invalid credentials" (no account enumeration), and
 *    correct credentials are rejected while a window is active.
 * 4. RBAC MATRIX: role → permission model boundaries (VIEWER read-only,
 *    SCHEDULER without ADMIN-only grants, SUPER_ADMIN identical to ADMIN and
 *    never beyond the approved model).
 * 5. IDOR / GRANT OWNERSHIP: cross-user mark-read is a no-op; a FINALIZED
 *    correction grant is unusable by a non-holder; altered week ids 404.
 * 6. LANGUAGE HARD RULE regression: ADMIN override cannot assign a Filipino
 *    teacher to an English dako (LANGUAGE_MISMATCH non-overrideable).
 * 7. APPEND-ONLY HISTORY: direct assignment_history deletion is blocked by
 *    the DB guard outside the approved transactional cascade.
 * 8. SECURITY HEADERS: next.config emits the Phase 9 header set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, seedScheduler, teardown, db, sql as testSql } from "./helpers";
import * as schema from "@/server/db/schema";
import { fail } from "@/server/api/helpers";
import { ValidationError } from "@/lib/errors";
import { isoWeekDates } from "@/lib/iso-week";
import { hashPassword } from "@/server/auth/password";
import { hasPermission } from "@/server/auth/permissions";
import type { SessionUser } from "@/server/auth/session";
import {
  setThrottleClock,
  loginThrottleCheck,
  loginThrottleRecordFailure,
  loginThrottleRecordSuccess,
} from "@/server/auth/login-throttle";
import { login } from "@/server/auth/auth.service";
import { createAssignment, changeAssignment } from "@/server/services/assignment.service";
import { beginFinalizedCorrection } from "@/server/services/correction.service";
import { markNotificationsRead } from "@/server/services/notification.service";
import nextConfig, { securityHeadersFor } from "../../next.config";

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

const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/** Discover every API route module under src/app/api (vitest resolves the @ alias). */
const routeModules = (): Array<{ path: string; mod: Record<string, unknown> }> =>
  Object.entries(
    import.meta.glob("../../src/app/api/**/route.ts", { eager: true }) as Record<string, Record<string, unknown>>,
  ).map(([path, mod]) => ({ path, mod }));

/**
 * The ONE route that is deliberately reachable without a session.
 *
 * `/api/health` is the local launcher's readiness probe: the launcher has no
 * session, so it cannot authenticate. It is safe to exempt because (a) the
 * packaged server binds to 127.0.0.1, so it is unreachable off the machine, and
 * (b) the payload is limited to liveness booleans — see the dedicated assertion
 * below, which fails if a sensitive field is ever added. Every other exported
 * handler must still reject anonymous requests.
 */
const ANONYMOUS_ALLOWED = ["/api/health/route.ts"];
const isAnonymousAllowed = (path: string) => ANONYMOUS_ALLOWED.some((p) => path.endsWith(p));

/** Insert a week row directly (avoids the validated service path in fixtures). */
async function mkWeek(year: number, week: number, status = "DRAFT") {
  const { startDate, endDate } = isoWeekDates(year, week);
  const rows = await db
    .insert(schema.weeks)
    .values({ year, isoWeekNumber: week, startDate, endDate, status })
    .returning();
  return rows[0]!;
}

/** Insert an ACTIVE dako row directly (service would be fine, too; keep fixtures lean). */
async function mkDako(dakoCode: string, name: string, language: "FILIPINO" | "ENGLISH") {
  const rows = await db
    .insert(schema.dako)
    .values({
      dakoCode,
      name,
      address: "Test Address",
      dateEstablished: "2000-01-01",
      worshipDay: "SUNDAY",
      worshipTime: "09:00",
      language,
      status: "ACTIVE",
    })
    .returning();
  return rows[0]!;
}

/** Insert an ACTIVE teacher row directly. */
async function mkTeacher(teacherCode: string, first: string, last: string, language: "FILIPINO" | "ENGLISH") {
  const rows = await db
    .insert(schema.teachers)
    .values({ teacherCode, firstName: first, lastName: last, language, status: "ACTIVE" })
    .returning();
  return rows[0]!;
}

describe("Phase 9 — anonymous request sweep (every guarded route export)", () => {
  it("rejects unauthenticated requests on every exported HTTP handler with a non-2xx status", async () => {
    const modules = routeModules();
    expect(modules.length).toBeGreaterThanOrEqual(20);

    let handlersTested = 0;
    let exempted = 0;
    for (const { path, mod } of modules) {
      if (isAnonymousAllowed(path)) {
        exempted++;
        continue;
      }
      for (const method of HTTP_METHODS) {
        const handler = mod[method];
        if (typeof handler !== "function") continue;
        handlersTested++;
        const req = new Request(`http://localhost:3000/api/test-sweep`, { method });
        let res: Response;
        try {
          res = await (handler as (r: Request) => Promise<Response>)(req);
        } catch (err) {
          // Route handlers may surface the out-of-request-scope cookies() error
          // directly in the test runtime — that is still a hard rejection.
          expect(String(err)).toBeDefined();
          continue;
        }
        expect(res.status, `${path} ${method} must not succeed anonymously`).toBeGreaterThanOrEqual(400);
        const text = await res.text();
        expect(text).not.toContain('"data"'); // never a success payload
      }
    }
    // Guard against the table silently rotting, and against the exemption list
    // growing unnoticed: exactly one route may be anonymously reachable.
    expect(handlersTested).toBeGreaterThan(25);
    expect(exempted).toBe(1);
  });

  it("the exempted readiness route exposes liveness booleans and nothing sensitive", async () => {
    const mod = (await import("../../src/app/api/health/route")) as {
      GET: (r: Request) => Promise<Response>;
    };
    const res = await mod.GET(new Request("http://localhost:3000/api/health"));
    // 200 when the database answers, 503 when it does not — never a 5xx crash.
    expect([200, 503]).toContain(res.status);

    const body = (await res.json()) as Record<string, unknown>;
    // The exact key set is pinned: adding a leaky field breaks this test.
    expect(Object.keys(body).sort()).toEqual(["db", "ready", "status", "uptimeSeconds"]);
    expect(typeof body.ready).toBe("boolean");
    expect(typeof body.db).toBe("boolean");

    // No credential, connection string, version or user data may appear.
    const text = JSON.stringify(body).toLowerCase();
    for (const needle of ["postgres", "password", "secret", "token", "user", "@", "http"]) {
      expect(text, `health payload must not contain "${needle}"`).not.toContain(needle);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2 — fail() sanitization                                            */
/* ------------------------------------------------------------------ */

describe("Phase 9 — 500 response sanitization", () => {
  it("returns a fixed generic body for unexpected errors (no internals leak)", async () => {
    const leaky = new Error('relation "pnk_internal_secrets" does not exist at statement 42');
    const res = fail(leaky);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("internal error");
    expect(JSON.stringify(body)).not.toContain("pnk_internal_secrets");
    expect(JSON.stringify(body)).not.toContain("statement 42");
  });

  it("preserves intentional AppError messages (e.g. validation) untouched", async () => {
    const res = fail(new ValidationError("week is out of range"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("week is out of range");
  });
});

/* ------------------------------------------------------------------ */
/* 3 — login throttling                                               */
/* ------------------------------------------------------------------ */

describe("Phase 9 — login throttling", () => {
  it("applies capped exponential backoff per account and resets on success", () => {
    let now = 1_000_000;
    setThrottleClock(() => now);
    const acct = "throttle-acct@test.local";
    const ip = "203.0.113.9";

    expect(loginThrottleCheck(acct, ip).allowed).toBe(true);

    loginThrottleRecordFailure(acct, ip);
    let v = loginThrottleCheck(acct, ip);
    expect(v.allowed).toBe(false);
    expect(v.retryAfterMs).toBe(500);

    now += 500;
    expect(loginThrottleCheck(acct, ip).allowed).toBe(true);
    loginThrottleRecordFailure(acct, ip);
    v = loginThrottleCheck(acct, ip);
    expect(v.retryAfterMs).toBe(1000);

    now += 1000;
    loginThrottleRecordFailure(acct, ip);
    expect(loginThrottleCheck(acct, ip).retryAfterMs).toBe(2000);

    // ...grows to the cap
    for (let i = 0; i < 10; i++) {
      now += 15_000;
      loginThrottleRecordFailure(acct, ip);
    }
    expect(loginThrottleCheck(acct, ip).retryAfterMs).toBe(15_000);

    loginThrottleRecordSuccess(acct, ip);
    expect(loginThrottleCheck(acct, ip).allowed).toBe(true);
  });

  it("isolates accounts and IPs (one account failing never throttles another)", () => {
    let now = 5_000_000;
    setThrottleClock(() => now);
    loginThrottleRecordFailure("acct-a@test.local", "198.51.100.1");
    expect(loginThrottleCheck("acct-b@test.local", "198.51.100.2").allowed).toBe(true);
    expect(loginThrottleCheck("acct-a@test.local", "198.51.100.2").allowed).toBe(false);
    expect(loginThrottleCheck("acct-b@test.local", "198.51.100.1").allowed).toBe(false);
  });

  it("service-level: correct credentials are rejected while a failure window is active, then succeed after backoff", async () => {
    let now = 9_000_000;
    setThrottleClock(() => now);
    const email = "victim@test.local";
    const passwordHash = await hashPassword("RealPassw0rd!");
    await db.insert(schema.users).values({ email, fullName: "Victim", passwordHash });

    // Wrong password → failure recorded.
    await expect(login(email, "wrong", { clientIp: "10.9.9.9" })).rejects.toThrow("Invalid credentials");
    // Immediate CORRECT login must still be throttled (no credential check yet).
    await expect(login(email, "RealPassw0rd!", { clientIp: "10.9.9.9" })).rejects.toThrow("Invalid credentials");
    // Advance past the 500 ms backoff → correct credentials succeed.
    now += 600;
    const result = await login(email, "RealPassw0rd!", { clientIp: "10.9.9.9" });
    expect(result.userId).toBeTruthy();
  });

  it("restores the real clock after throttle tests", () => {
    setThrottleClock(() => Date.now());
  });
});

/* ------------------------------------------------------------------ */
/* 4 — RBAC matrix                                                    */
/* ------------------------------------------------------------------ */

describe("Phase 9 — RBAC permission matrix", () => {
  it("VIEWER is strictly read-only", () => {
    for (const p of [
      "teachers.write",
      "dako.write",
      "weeks.write",
      "weeks.unlock", // L2: VIEWER must never enable FINALIZED revision
      "availability.write",
      "assignments.write",
      "scheduling.generate",
      "notifications.write",
      "audit.read",
      "users.manage",
    ] as const) {
      expect(hasPermission(["VIEWER"], p), `VIEWER must lack ${p}`).toBe(false);
    }
    expect(hasPermission(["VIEWER"], "reports.read")).toBe(true);
  });

  it("SCHEDULER has operational writes + FINALIZED revision, but no ADMIN-only grants", () => {
    expect(hasPermission(["SCHEDULER"], "assignments.write")).toBe(true);
    expect(hasPermission(["SCHEDULER"], "scheduling.generate")).toBe(true);
    // L2: `weeks.unlock` authorizes the FINALIZED revision window ONLY. It never
    // grants finalize, publish, or the PUBLISHED (SUPER_ADMIN-only) correction.
    expect(hasPermission(["SCHEDULER"], "weeks.unlock")).toBe(true);
    for (const p of [
      "weeks.finalize",
      "weeks.publish",
      "assignments.override",
      "users.manage",
      "audit.read",
      "notifications.write",
    ] as const) {
      expect(hasPermission(["SCHEDULER"], p), `SCHEDULER must lack ${p}`).toBe(false);
    }
  });

  it("SUPER_ADMIN equals the ADMIN set and never exceeds the approved model", () => {
    const admin = hasPermission(["ADMIN"], "audit.read") ? "ADMIN" : "?";
    expect(admin).toBe("ADMIN");
    for (const p of [
      "teachers.write",
      "assignments.override",
      "weeks.unlock",
      "notifications.write",
      "scheduling.generate",
      "reports.read",
    ] as const) {
      expect(hasPermission(["SUPER_ADMIN"], p)).toBe(true);
    }
    // No special reporting/backdoor permission beyond the approved model.
    for (const p of [
      "teachers.read",
      "assignments.read",
      "reports.read",
      "audit.read",
    ] as const) {
      expect(hasPermission(["SUPER_ADMIN"], p)).toBe(hasPermission(["ADMIN"], p));
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5 — IDOR / grant ownership                                         */
/* ------------------------------------------------------------------ */

describe("Phase 9 — IDOR and grant-ownership guards", () => {
  let adminId: string;
  let adminB: string;

  beforeAll(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
    adminB = await seedScheduler(); // second user (scheduler role) for cross-user tests
    // Promote scheduler user to a second ADMIN for grant-holder tests.
    const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, "ADMIN"));
    await db.insert(schema.userRoles).values({ userId: adminB, roleId: roleRows[0]!.id });
  });

  it("markNotificationsRead cannot touch another user's notifications", async () => {
    const notif = (
      await db
        .insert(schema.notifications)
        .values({
          userId: adminId,
          notificationType: "DAKO_ANNIVERSARY",
          title: "t",
          message: "m",
          relatedEntityType: "dako",
          relatedEntityId: null,
        })
        .returning()
    )[0]!;
    const changed = await markNotificationsRead(adminB, [notif.id]);
    expect(changed).toBe(0); // other user's row → no-op
    const stillUnread = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, notif.id));
    expect(stillUnread[0]!.readAt).toBeNull();
    // Owner can mark it read.
    expect(await markNotificationsRead(adminId, [notif.id])).toBe(1);
  });

  it("a FINALIZED correction grant is unusable by a non-holder (and scoped to its week)", async () => {
    const week = await mkWeek(2097, 5, "FINALIZED");

    await beginFinalizedCorrection(week.id, "admin A correction", actor(adminId, ["ADMIN"]));

    // Non-holder (also ADMIN) cannot write assignments to that week…
    const dakoRow = await mkDako("ILGD-9021", "Guard Dako", "FILIPINO");
    const teacher = await mkTeacher("PNK-G-9021", "Guard", "Teacher", "FILIPINO");
    await expect(
      createAssignment(
        { weekId: week.id, dakoId: dakoRow.id, teacherId: teacher.id, assignmentType: "SUGO" },
        actor(adminB, ["ADMIN"]),
      ),
    ).rejects.toThrow(/held by another user/);

    // …while the holder may.
    const created = await createAssignment(
      { weekId: week.id, dakoId: dakoRow.id, teacherId: teacher.id, assignmentType: "SUGO" },
      actor(adminId, ["ADMIN"]),
    );
    expect(created.assignment.assignmentSource).toBe("MANUAL");
  });

  it("altered / unknown week ids in assignment mutations resolve to NotFound, never to another week's data", async () => {
    await expect(
      changeAssignment(
        "00000000-0000-0000-0000-000000000001",
        { reason: "x" },
        actor(adminId, ["ADMIN"]),
      ),
    ).rejects.toThrow(/not found/i);
  });
});

/* ------------------------------------------------------------------ */
/* 6 — language hard rule regression                                  */
/* ------------------------------------------------------------------ */

describe("Phase 9 — language hard rule regression (override path)", () => {
  it("ADMIN + override reason cannot assign a Filipino teacher to an English dako", async () => {
    const adminId2 = await seedAdmin();
    const week = await mkWeek(2098, 3);
    const enDako = await mkDako("ILGD-9031", "English Dako", "ENGLISH");
    const filTeacher = await mkTeacher("PNK-G-9031", "Fil", "Teacher", "FILIPINO");
    await expect(
      createAssignment(
        {
          weekId: week.id,
          dakoId: enDako.id,
          teacherId: filTeacher.id,
          assignmentType: "SUGO",
          overrideReason: "emergency need",
        },
        actor(adminId2, ["ADMIN"]),
      ),
    ).rejects.toThrow(/not overridable/);
  });
});

/* ------------------------------------------------------------------ */
/* 7 — append-only assignment history                                 */
/* ------------------------------------------------------------------ */

describe("Phase 9 — assignment history stays append-only outside approved cascades", () => {
  it("direct DELETE on assignment_history is rejected by the database guard", async () => {
    const adminId3 = await seedAdmin();
    const week = await mkWeek(2099, 1);
    const dakoRow = await mkDako("ILGD-9041", "History Dako", "FILIPINO");
    const teacher = await mkTeacher("PNK-G-9041", "History", "Teacher", "FILIPINO");
    await createAssignment(
      { weekId: week.id, dakoId: dakoRow.id, teacherId: teacher.id, assignmentType: "SUGO" },
      actor(adminId3, ["ADMIN"]),
    );
    const hist = await db.select().from(schema.assignmentHistory);
    expect(hist.length).toBeGreaterThan(0);

    await expect(testSql`DELETE FROM assignment_history`).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 8 — security headers                                               */
/* ------------------------------------------------------------------ */

describe("Phase 9 — security headers configuration", () => {
  it("emits the Phase 9 header set on all routes", async () => {
    const headerList = (await nextConfig.headers?.()) ?? [];
    const headers = headerList[0]!.headers;
    const get = (key: string) => headers.find((h) => h.key === key)?.value;
    expect(get("X-Frame-Options")).toBe("DENY");
    expect(get("X-Content-Type-Options")).toBe("nosniff");
    expect(get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    const csp = get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Dev-only relaxation: vitest runs with NODE_ENV=test, so the dev branch
    // applies and React/Next.js dev-mode eval() is permitted.
    expect(csp).toContain("unsafe-eval");
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline' 'unsafe-eval'/);
  });

  it("excludes 'unsafe-eval' from the CSP for production while keeping it in dev", () => {
    const findCsp = (rows: Array<{ key: string; value: string }>) =>
      rows.find((h) => h.key === "Content-Security-Policy")!.value;
    const prod = findCsp(securityHeadersFor(false));
    const dev = findCsp(securityHeadersFor(true));
    expect(prod).not.toContain("unsafe-eval");
    expect(prod).toMatch(/script-src 'self' 'unsafe-inline';/);
    expect(dev).toContain("unsafe-eval");
    expect(prod).toContain("frame-ancestors 'none'");
  });
});

afterAll(async () => {
  await teardown();
});
