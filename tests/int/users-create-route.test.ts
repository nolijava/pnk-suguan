/**
 * REVISION #2 regression — POST /api/users, on the wire.
 *
 * WHY THIS FILE EXISTS. The Create User form answered a bare "Request failed."
 * for every field-level rejection. The cause was a contract gap, not a server
 * fault: `fail()` mapped a ZodError to `422 { error: { code, issues } }` with NO
 * `message` — the only error branch in the whole API without one — while every
 * client reads `error.message`. A short password or a malformed email therefore
 * produced a message-less 422 that the UI could only render as its fallback
 * literal. The suite below pins the fixed contract so it cannot regress:
 *
 *   1. AUTHORIZATION RUNS FIRST. Anonymous → 401, and a caller without
 *      `users.manage` → 403, both BEFORE the body is parsed, so an unauthorized
 *      caller learns nothing about the payload contract.
 *   2. A rejected body answers a 422 that carries a READABLE `message` naming
 *      the offending field, alongside the structured `issues` array (clients map
 *      those onto individual controls).
 *   3. A business-rule rejection (weak password, duplicate email) keeps its own
 *      human message and its own status (422 / 409).
 *   4. A successful create returns only the account projection — never the
 *      password, the hash, or anything argon2-shaped.
 *
 * `requirePermission` reads the session through `next/headers`, which has no
 * request scope under vitest, so only `cookies()` is mocked and it is driven by
 * a variable: every case is a real call into the real handler with the real
 * service and the real database behind it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";

import { POST as usersPost } from "@/app/api/users/route";

const auth = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      auth.token !== undefined && name === SESSION_COOKIE ? { name, value: auth.token } : undefined,
  }),
}));

/** A payload the API accepts: it exists to prove the happy path still works. */
const VALID = {
  email: "created.by.test@test.local",
  fullName: "Created By Test",
  password: "Str0ng!Passw0rd",
  roleCode: "VIEWER" as const,
};

function post(body: unknown): Promise<Response> {
  return usersPost(
    new Request("http://localhost:3000/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type ErrorBody = { code?: string; message?: string; issues?: { path?: string; message?: string }[] };
const errorOf = (body: Record<string, unknown>): ErrorBody => (body.error ?? {}) as ErrorBody;

async function makeSession(role: "ADMIN" | "SCHEDULER" | "VIEWER"): Promise<string> {
  const inserted = await db
    .insert(schema.users)
    .values({ email: `${role.toLowerCase()}-create@test.local`, fullName: `${role} Create`, passwordHash: "x" })
    .returning();
  const userId = inserted[0]!.id;
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, role));
  await db.insert(schema.userRoles).values({ userId, roleId: roleRows[0]!.id });
  const { token } = await createSession(userId);
  return token;
}

let adminToken: string;
let schedulerToken: string;
let viewerToken: string;

beforeAll(async () => {
  await resetTestDb();
  await seedAdmin();
  adminToken = await makeSession("ADMIN");
  schedulerToken = await makeSession("SCHEDULER");
  viewerToken = await makeSession("VIEWER");
  auth.token = adminToken; // armed before the first test, not only by afterEach
});

afterEach(() => {
  auth.token = adminToken; // never let a case leak its identity into the next
});

afterAll(async () => {
  auth.token = undefined;
  await teardown();
});

/* ------------------------------------------------------------------ */
/* 1 — authorization precedes validation                               */
/* ------------------------------------------------------------------ */

describe("POST /api/users — authorization runs before the body is read", () => {
  it("answers 401 for an anonymous caller, even with a malformed body", async () => {
    auth.token = undefined;
    const res = await post({ nonsense: true });
    const error = errorOf(await bodyOf(res));

    expect(res.status).toBe(401);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.issues).toBeUndefined(); // the payload contract stays hidden
  });

  it("answers 403 for SCHEDULER and VIEWER, even with a valid body", async () => {
    for (const [role, token] of [
      ["SCHEDULER", schedulerToken],
      ["VIEWER", viewerToken],
    ] as const) {
      auth.token = token;
      const res = await post(VALID);
      const error = errorOf(await bodyOf(res));

      expect(res.status, `${role} must not be able to create accounts`).toBe(403);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.issues).toBeUndefined();
    }
  });

  it("never grants SCHEDULER users.manage implicitly", async () => {
    auth.token = schedulerToken;
    const res = await post(VALID);
    expect(res.status).toBe(403);

    const created = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, VALID.email));
    expect(created, "a denied request must not write a user row").toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 2 — a rejected body must be EXPLAINABLE                             */
/* ------------------------------------------------------------------ */

describe("POST /api/users — a rejected body carries a readable message", () => {
  /* Each case: the bad payload, and the field its message must name. */
  const CASES: { label: string; body: unknown; field: string }[] = [
    { label: "password under the 10-character minimum", body: { ...VALID, password: "Sh0rt!Ab" }, field: "password" },
    { label: "malformed email", body: { ...VALID, email: "not-an-email" }, field: "email" },
    { label: "empty full name", body: { ...VALID, fullName: "" }, field: "fullName" },
    { label: "missing full name", body: { email: VALID.email, password: VALID.password, roleCode: "VIEWER" }, field: "fullName" },
    { label: "SUPER_ADMIN as the requested role", body: { ...VALID, roleCode: "SUPER_ADMIN" }, field: "roleCode" },
    { label: "an unknown extra field", body: { ...VALID, isAdmin: true }, field: "body" },
  ];

  for (const testCase of CASES) {
    it(`explains: ${testCase.label}`, async () => {
      const res = await post(testCase.body);
      const body = await bodyOf(res);
      const error = errorOf(body);

      expect(res.status).toBe(422);
      expect(error.code).toBe("VALIDATION_ERROR");

      // THE REGRESSION: this used to be `undefined`, which is precisely why the
      // UI collapsed every rejection into its "Request failed." fallback.
      expect(typeof error.message, "a 422 must carry a message the client can show").toBe("string");
      expect(error.message).toBeTruthy();
      expect(error.message).not.toBe("Request failed.");
      expect(error.message?.toLowerCase()).toContain(testCase.field.toLowerCase());

      // The structured half stays, for field-level display.
      expect(Array.isArray(error.issues)).toBe(true);
      expect(error.issues!.length).toBeGreaterThan(0);
      expect(error.issues!.some((i) => i.path === testCase.field || i.path === "")).toBe(true);

      // Nothing about the server's insides leaks through the new message.
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/argon2|passwordHash|at Object\.|node_modules|pg_|relation /i);
    });
  }

  it("writes no user row for a rejected body", async () => {
    const rows = await db.select().from(schema.users).where(eq(schema.users.email, VALID.email));
    expect(rows).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3 — business-rule rejections keep their own message and status      */
/* ------------------------------------------------------------------ */

describe("POST /api/users — business rules report themselves", () => {
  it("rejects a 10-character but weak password with a 422 that names the rule", async () => {
    const res = await post({ ...VALID, password: "alllowercase" });
    const error = errorOf(await bodyOf(res));

    expect(res.status).toBe(422);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toMatch(/too weak/i);
  });

  it("rejects a duplicate email with a 409 that carries a message", async () => {
    const first = await post(VALID);
    expect(first.status).toBe(201);

    const second = await post({ ...VALID, fullName: "Duplicate Attempt" });
    const error = errorOf(await bodyOf(second));

    expect(second.status).toBe(409);
    expect(error.code).toBe("CONFLICT");
    expect(typeof error.message).toBe("string");
    expect(error.message).toMatch(/already exists/i);

    const rows = await db.select().from(schema.users).where(eq(schema.users.email, VALID.email));
    expect(rows, "the duplicate attempt must not create a second row").toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4 — the happy path, and what it may return                          */
/* ------------------------------------------------------------------ */

describe("POST /api/users — an authorized create succeeds without leaking secrets", () => {
  it("creates the account, returns only the projection, and writes the audit row", async () => {
    const email = "revision.two@test.local";
    const res = await post({ ...VALID, email, fullName: "Revision Two" });
    const raw = await res.text();
    const body = JSON.parse(raw) as { data?: Record<string, unknown> };

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({ email, fullName: "Revision Two", roleCode: "VIEWER" });
    expect(typeof body.data?.id).toBe("string");

    // Neither the chosen password nor a hash of it may travel back to the client.
    expect(raw).not.toContain(VALID.password);
    expect(raw).not.toMatch(/passwordHash|\$argon2/i);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    expect(row, "the user row must exist").toBeTruthy();
    expect(row!.mustChangePassword, "first-run rotation must be forced").toBe(true);
    expect(row!.passwordHash).not.toContain(VALID.password); // stored hashed, never plain

    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, row!.id));
    expect(audits.some((a) => a.action === "CREATED_USER")).toBe(true);
    // The audit trail records the account, never the secret.
    expect(JSON.stringify(audits)).not.toContain(VALID.password);
  });
});
