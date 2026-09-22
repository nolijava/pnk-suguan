/**
 * L6 — QUERY-PARAMETER CONTRACT (every guarded route).
 *
 * A missing or malformed REQUIRED query parameter is the CALLER's error, so the
 * contract is a structured 400 BAD_REQUEST. Two failure modes are pinned here,
 * both of which used to answer the sanitized 500:
 *
 *   1. `return fail(new Error("weekId query param is required"))` — a plain
 *      Error, which the Phase 9 sanitizer (correctly) turns into
 *      `{ error: { code: "INTERNAL", message: "internal error" } }` with status
 *      500. A server error for a client mistake, and useless to the caller.
 *   2. Passing the raw string straight into a query, where a malformed uuid /
 *      enum / integer surfaced as a driver error (`invalid input syntax for type
 *      uuid`, `invalid input value for enum`, a `limit(NaN)`) and the same 500.
 *
 * The order of the checks is part of the contract and is asserted per route:
 * AUTHORIZATION RUNS FIRST, so an anonymous caller gets 401 and learns nothing
 * about which parameters exist or what their valid ranges are. Only an
 * authenticated, authorized caller can ever observe the 400.
 *
 * `requirePermission` reads the session through `next/headers`, which has no
 * request scope under vitest, so only `cookies()` is mocked and it is driven by
 * a variable — every case is a real HTTP-shaped call into the real handler with
 * the real services and the real database behind it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, db } from "./helpers";
import * as schema from "@/server/db/schema";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";

import { GET as assignmentsGet } from "@/app/api/assignments/route";
import { GET as assignmentCountsGet } from "@/app/api/assignment-counts/route";
import { GET as auditLogsGet } from "@/app/api/audit-logs/route";
import { GET as availabilityGet } from "@/app/api/availability/route";
import { GET as fillBlanksGet } from "@/app/api/availability/fill-blanks/route";
import { GET as dakoGet } from "@/app/api/dako/route";
import { DELETE as dakoDelete } from "@/app/api/dako/[id]/route";
import { GET as teachersGet } from "@/app/api/teachers/route";
import { DELETE as teachersDelete } from "@/app/api/teachers/[id]/route";
import { GET as usersGet } from "@/app/api/users/route";
import { GET as weeksGet } from "@/app/api/weeks/route";
import { GET as annualGet } from "@/app/api/schedule/annual/route";
import { GET as pdfGet } from "@/app/api/schedule/weekly-suguan-pdf/route";
import { GET as absencesGet } from "@/app/api/scheduling/previous-week-absences/route";
import { GET as slotCandidatesGet } from "@/app/api/scheduling/slot-candidates/route";

const auth = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      auth.token !== undefined && name === SESSION_COOKIE ? { name, value: auth.token } : undefined,
  }),
}));

/** Well-formed but absent: every lookup behind this id is a legitimate 404. */
const UNKNOWN_ID = "11111111-1111-4111-8111-111111111111";
/** Well-formed shape, wrong type — must be rejected before any SQL runs. */
const MALFORMED_ID = "not-a-uuid";

const url = (path: string, query: string) => new Request(`http://localhost:3000${path}${query}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

type RouteCase = {
  label: string;
  call: (query: string) => Promise<Response>;
  /** Queries that MUST answer 400 BAD_REQUEST (missing / malformed input). */
  bad: string[];
  /** Queries that must NOT be rejected as validation errors. */
  good: string[];
};

const ROUTES: RouteCase[] = [
  {
    label: "GET /api/assignments",
    call: (q) => assignmentsGet(url("/api/assignments", q)),
    bad: ["", "?weekId=", `?weekId=${MALFORMED_ID}`],
    good: [`?weekId=${UNKNOWN_ID}`], // no rows for that week → 200 []
  },
  {
    label: "GET /api/assignment-counts",
    call: (q) => assignmentCountsGet(url("/api/assignment-counts", q)),
    bad: [`?teacherId=${MALFORMED_ID}`, `?dakoId=${MALFORMED_ID}`, "?assignmentType=NOPE"],
    good: ["", `?teacherId=${UNKNOWN_ID}`, "?assignmentType=SUGO"],
  },
  {
    label: "GET /api/audit-logs",
    call: (q) => auditLogsGet(url("/api/audit-logs", q)),
    bad: [
      "?page=abc",
      "?page=0",
      "?pageSize=abc",
      "?pageSize=0",
      "?pageSize=9999", // above the 200 ceiling
      `?entityId=${MALFORMED_ID}`,
    ],
    good: ["", "?page=1&pageSize=50", "?entityType=week", `?entityId=${UNKNOWN_ID}`],
  },
  {
    label: "GET /api/availability",
    call: (q) => availabilityGet(url("/api/availability", q)),
    bad: ["", "?weekId=", `?weekId=${MALFORMED_ID}`, `?weekId=${UNKNOWN_ID}&language=NOPE`],
    good: [`?weekId=${UNKNOWN_ID}`], // unknown week → 404, not a validation error
  },
  {
    label: "GET /api/availability/fill-blanks",
    call: (q) => fillBlanksGet(url("/api/availability/fill-blanks", q)),
    bad: ["", `?weekId=${MALFORMED_ID}`],
    good: [`?weekId=${UNKNOWN_ID}`],
  },
  {
    label: "GET /api/dako",
    call: (q) => dakoGet(url("/api/dako", q)),
    bad: ["?page=abc", "?pageSize=abc", "?status=NOPE", "?language=KLINGON", "?worshipDay=FUNDAY"],
    good: ["", "?page=1&pageSize=25", "?status=ACTIVE"],
  },
  {
    label: "GET /api/teachers",
    call: (q) => teachersGet(url("/api/teachers", q)),
    bad: ["?page=abc", "?pageSize=abc", "?status=NOPE", "?language=NOPE", `?currentDestinationId=${MALFORMED_ID}`],
    good: ["", "?page=1&pageSize=25", "?status=ACTIVE"],
  },
  {
    label: "GET /api/users",
    call: (q) => usersGet(url("/api/users", q)),
    bad: ["?role=NOPE", "?status=NOPE"],
    good: ["", "?role=ADMIN", "?q=test"],
  },
  {
    label: "GET /api/weeks",
    call: (q) => weeksGet(url("/api/weeks", q)),
    bad: ["?year=", "?year=abc", "?year=20.5", "?year=1800", "?year=9999"],
    good: ["", "?year=2089"],
  },
  {
    label: "GET /api/schedule/annual",
    call: (q) => annualGet(url("/api/schedule/annual", q)),
    bad: ["", "?year=", "?year=abc", "?year=20.5", "?year=1800", "?year=9999"],
    good: ["?year=2089"],
  },
  {
    label: "GET /api/schedule/weekly-suguan-pdf",
    call: (q) => pdfGet(url("/api/schedule/weekly-suguan-pdf", q)),
    // `week` is bounded by the ISO week count of the year, so 53/99 depend on it.
    bad: ["", "?year=2089", "?week=1", "?year=abc&week=1", "?year=2089&week=abc", "?year=2089&week=0", "?year=2089&week=99"],
    good: ["?year=2089&week=1"], // week not started → 404, never a client-input 400
  },
  {
    label: "GET /api/scheduling/previous-week-absences",
    call: (q) => absencesGet(url("/api/scheduling/previous-week-absences", q)),
    bad: ["", "?weekId=", `?weekId=${MALFORMED_ID}`],
    good: [`?weekId=${UNKNOWN_ID}`], // unknown week → 404
  },
  {
    label: "GET /api/scheduling/slot-candidates",
    call: (q) => slotCandidatesGet(url("/api/scheduling/slot-candidates", q)),
    bad: [
      "",
      `?weekId=${UNKNOWN_ID}&dakoId=${UNKNOWN_ID}`, // assignmentType missing
      `?weekId=${MALFORMED_ID}&dakoId=${UNKNOWN_ID}&assignmentType=SUGO`,
      `?weekId=${UNKNOWN_ID}&dakoId=${UNKNOWN_ID}&assignmentType=NOPE`,
      `?weekId=${UNKNOWN_ID}&dakoId=${UNKNOWN_ID}&assignmentType=SUGO&assignmentId=${MALFORMED_ID}`,
    ],
    good: [`?weekId=${UNKNOWN_ID}&dakoId=${UNKNOWN_ID}&assignmentType=SUGO`], // unknown week/dako → 404
  },
  {
    label: "DELETE /api/dako/[id]",
    call: (q) => dakoDelete(url(`/api/dako/${UNKNOWN_ID}`, q), params(UNKNOWN_ID)),
    bad: ["", "?reason=", "?reason=%20"],
    good: ["?reason=QA disabling check"], // unknown id → 404
  },
  {
    label: "DELETE /api/teachers/[id]",
    call: (q) => teachersDelete(url(`/api/teachers/${UNKNOWN_ID}`, q), params(UNKNOWN_ID)),
    bad: ["", "?reason=", "?reason=%20"],
    good: ["?reason=QA deactivation check"], // unknown id → 404
  },
];

let adminToken: string;
let viewerToken: string;

async function makeSession(role: "ADMIN" | "VIEWER"): Promise<string> {
  const inserted = await db
    .insert(schema.users)
    .values({
      email: `${role.toLowerCase()}-query@test.local`,
      fullName: `${role} Query`,
      passwordHash: "x",
    })
    .returning();
  const userId = inserted[0]!.id;
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, role));
  await db.insert(schema.userRoles).values({ userId, roleId: roleRows[0]!.id });
  const { token } = await createSession(userId);
  return token;
}

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

/** Every response body a 400 path may produce, without assuming its shape. */
async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorOf(body: Record<string, unknown>): { code?: string; message?: string } {
  return (body.error ?? {}) as { code?: string; message?: string };
}

/* ------------------------------------------------------------------ */
/* 1 — the contract, per route                                        */
/* ------------------------------------------------------------------ */

describe("query parameters — structured 400 instead of the sanitized 500", () => {
  it("covers every query-parameter route in the API surface", () => {
    // Guards against the table silently rotting as routes are added.
    expect(ROUTES.length).toBe(15);
    expect(ROUTES.every((r) => r.bad.length > 0)).toBe(true);
  });

  for (const route of ROUTES) {
    describe(route.label, () => {
      it("answers 400 BAD_REQUEST for a missing or malformed parameter — never the 500", async () => {
        for (const query of route.bad) {
          const res = await route.call(query);
          const body = await bodyOf(res);
          const error = errorOf(body);

          expect(res.status, `${route.label} "${query}" must be a client error, not a server one`).toBe(400);
          expect(error.code, `${route.label} "${query}" must carry the BAD_REQUEST code`).toBe("BAD_REQUEST");
          // The exact shapes this contract replaces.
          expect(error.code).not.toBe("INTERNAL");
          expect(error.message).not.toBe("internal error");
          expect(body).not.toHaveProperty("data");
          // No driver/DB detail and no generic server-error text may leak.
          const text = JSON.stringify(body);
          expect(text).not.toMatch(/invalid input syntax|invalid input value for enum|pg_|relation |statement/i);
        }
      });

      it("still accepts well-formed input (validation did not narrow the API)", async () => {
        for (const query of route.good) {
          const res = await route.call(query);
          expect(res.status, `${route.label} "${query}" must not be a validation failure`).not.toBe(400);
          expect(res.status, `${route.label} "${query}" must not be a server failure`).toBeLessThan(500);
        }
      });

      it("authorizes the caller BEFORE it ever looks at the parameter", async () => {
        auth.token = undefined;
        try {
          for (const query of [...route.bad, ...route.good]) {
            const res = await route.call(query);
            expect(
              [401, 403],
              `${route.label} "${query}" must not describe a parameter to an anonymous caller`,
            ).toContain(res.status);
          }
        } finally {
          auth.token = adminToken;
        }
      });
    });
  }
});

/* ------------------------------------------------------------------ */
/* 2 — the exact historical failures, named                           */
/* ------------------------------------------------------------------ */

describe("query parameters — the named regressions", () => {
  it("a required param that is absent is 'required', not an internal failure", async () => {
    // These five used to `fail(new Error(...))` → 500 INTERNAL.
    for (const [label, call] of [
      ["GET /api/assignments", (q: string) => assignmentsGet(url("/api/assignments", q))],
      ["GET /api/scheduling/previous-week-absences", (q: string) => absencesGet(url("/api/scheduling/previous-week-absences", q))],
      ["GET /api/scheduling/slot-candidates", (q: string) => slotCandidatesGet(url("/api/scheduling/slot-candidates", q))],
      ["DELETE /api/dako/[id]", (q: string) => dakoDelete(url(`/api/dako/${UNKNOWN_ID}`, q), params(UNKNOWN_ID))],
      ["DELETE /api/teachers/[id]", (q: string) => teachersDelete(url(`/api/teachers/${UNKNOWN_ID}`, q), params(UNKNOWN_ID))],
    ] as const) {
      const res = await call("");
      const body = await bodyOf(res);
      expect(res.status, `${label} must not 500 on a missing required param`).toBe(400);
      expect(errorOf(body).code).toBe("BAD_REQUEST");
      expect(errorOf(body).message).toMatch(/required|invalid/i);
    }
  });

  it("a malformed uuid is refused before any SQL runs (it used to be a driver error)", async () => {
    // `entity_id` is a uuid column: the raw string used to reach the planner.
    const res = await auditLogsGet(url("/api/audit-logs", `?entityId=${MALFORMED_ID}`));
    expect(res.status).toBe(400);
    const text = JSON.stringify(await bodyOf(res));
    // The DRIVER wording is what must never appear. Zod's own "Invalid UUID"
    // is a description of the input's shape and is deliberately allowed — it
    // tells the caller what to fix without describing the server.
    expect(text).not.toMatch(/invalid input syntax|type uuid|pg_|relation |statement/i);

    // A malformed weekId on a bare `.get()` path behaved the same way.
    const res2 = await assignmentsGet(url("/api/assignments", `?weekId=${MALFORMED_ID}`));
    expect(res2.status).toBe(400);
    expect(errorOf(await bodyOf(res2)).code).toBe("BAD_REQUEST");
  });

  it("a malformed page number cannot become a NaN LIMIT", async () => {
    // `Number("abc")` → NaN reached `.limit()`, which the driver rejected.
    for (const query of ["?page=abc", "?pageSize=abc"]) {
      const res = await auditLogsGet(url("/api/audit-logs", query));
      expect(res.status, query).toBe(400);
    }
  });

  it("an out-of-range ISO week is a 400 for that year, not a 500 or a silent clamp", async () => {
    const res = await pdfGet(url("/api/schedule/weekly-suguan-pdf", "?year=2089&week=54"));
    expect(res.status).toBe(400);
    expect(errorOf(await bodyOf(res)).code).toBe("BAD_REQUEST");
  });

  it("a VIEWER still receives the parameter verdict on routes it may read", async () => {
    // Authorization is not authentication: a permitted caller sees the 400.
    auth.token = viewerToken;
    try {
      expect((await assignmentsGet(url("/api/assignments", ""))).status).toBe(400);
      expect((await annualGet(url("/api/schedule/annual", ""))).status).toBe(400);
      // …while a route the VIEWER may not use still answers 403, not a 400 that
      // would confirm the parameter's existence.
      expect((await pdfGet(url("/api/schedule/weekly-suguan-pdf", ""))).status).toBe(403);
      expect((await usersGet(url("/api/users", "?role=NOPE"))).status).toBe(403);
    } finally {
      auth.token = adminToken;
    }
  });
});
