/**
 * L5 — GET /api/schedule/annual contract.
 *
 * A MISSING or malformed `year` is caller error, so the route must answer with
 * a structured client-input validation response (400 BAD_REQUEST). It used to
 * `fail(new Error(...))`, which the Phase 9 sanitizer turns into a generic 500 —
 * a server error for a client mistake, and useless to the caller.
 *
 * The order of the checks is part of the contract: authorization is evaluated
 * FIRST, so an anonymous caller gets 401 and a signed-in VIEWER (who holds
 * `assignments.read`) gets the annual payload. Only an authenticated caller can
 * ever observe the 400.
 *
 * `requirePermission` reads the session through `next/headers`, which has no
 * request scope under vitest, so only `cookies()` is mocked and it is driven by
 * a variable — every case below is a real HTTP-shaped call into the real
 * handler with the real services and the real database behind it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import { isoWeeksInYear } from "@/lib/iso-week";
import { GET } from "@/app/api/schedule/annual/route";

const auth = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      auth.token !== undefined && name === SESSION_COOKIE ? { name, value: auth.token } : undefined,
  }),
}));

const YEAR = 2088;

function get(query = ""): Promise<Response> {
  return GET(new Request(`http://localhost:3000/api/schedule/annual${query}`));
}

async function makeSession(role: "ADMIN" | "VIEWER"): Promise<string> {
  const inserted = await db
    .insert(schema.users)
    .values({
      email: `${role.toLowerCase()}-annual@test.local`,
      fullName: `${role} Annual`,
      passwordHash: "x",
    })
    .returning();
  const userId = inserted[0]!.id;
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, role));
  await db.insert(schema.userRoles).values({ userId, roleId: roleRows[0]!.id });
  const { token } = await createSession(userId);
  return token;
}

let adminToken: string;
let viewerToken: string;

beforeAll(async () => {
  await resetTestDb();
  await seedAdmin();
  adminToken = await makeSession("ADMIN");
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

describe("GET /api/schedule/annual — input validation", () => {
  it("rejects a MISSING year with 400 and a structured, non-leaky error", async () => {
    const res = await get();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string }; data?: unknown };
    expect(body.error?.code).toBe("BAD_REQUEST");
    expect(typeof body.error?.message).toBe("string");
    expect(body).not.toHaveProperty("data");
    // Never the sanitized internal-error shape this used to return.
    expect(body.error?.code).not.toBe("INTERNAL");
  });

  it("rejects malformed or out-of-range years with 400 (never 500)", async () => {
    for (const query of ["?year=", "?year=abc", "?year=20.5", "?year=1800", "?year=2999.5", "?year=9999"]) {
      const res = await get(query);
      expect(res.status, `year query ${query} must be a client error`).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("BAD_REQUEST");
    }
  });

  it("accepts a valid year and returns the annual payload", async () => {
    const res = await get(`?year=${YEAR}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { year: number; weekCount: number; tables: unknown[] };
    };
    expect(body.data.year).toBe(YEAR);
    expect(body.data.weekCount).toBe(isoWeeksInYear(YEAR));
    expect(body.data.tables).toHaveLength(3);
  });

  it("treats the range bounds as inclusive (1900 and 2999 are valid years)", async () => {
    for (const year of [1900, 2999]) {
      const res = await get(`?year=${year}`);
      expect(res.status, `year ${year} must be accepted`).toBe(200);
    }
  });
});

describe("GET /api/schedule/annual — authorization is evaluated first", () => {
  it("rejects an anonymous caller with 401 before any parameter is looked at", async () => {
    auth.token = undefined;
    // Both with and without `year`: authentication is never bypassed by input.
    for (const query of ["", `?year=${YEAR}`, "?year=not-a-year"]) {
      const res = await get(query);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string }; data?: unknown };
      expect(body.error?.code).toBe("UNAUTHORIZED");
      expect(body).not.toHaveProperty("data");
    }
  });

  it("serves a VIEWER (assignments.read) — the fix narrowed nothing", async () => {
    auth.token = viewerToken;
    expect((await get(`?year=${YEAR}`)).status).toBe(200);
    expect((await get()).status).toBe(400); // validation still applies
  });
});
