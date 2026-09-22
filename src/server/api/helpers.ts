import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError, BadRequestError } from "@/lib/errors";

export function ok<T>(data: T, status = 200, headers?: Record<string, string>) {
  return NextResponse.json({ data }, { status, ...(headers ? { headers } : {}) });
}

export function fail(error: unknown) {
  if (error instanceof ZodError) {
    // A Zod rejection carries `issues` (which field, which rule) but used to
    // carry NO `message` — the only error branch in the app without one. Clients
    // read `error.message`, so every field-level rejection collapsed into a
    // generic "Request failed." with no field identified: that is exactly how the
    // Create User form failed (a short password or a malformed email produced an
    // unexplained failure instead of "password: too small"). The message is
    // derived from the issues the same way `parseQuery` does — field names plus
    // Zod's own wording about the INPUT shape, never server internals.
    const issues = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: describeBodyIssues(error), issues } },
      { status: 422 },
    );
  }
  if (error instanceof AppError) {
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  // Phase 9 — unexpected (non-AppError) failures must never leak internals
  // (SQL text, driver errors, paths) to the client. Full detail stays in the
  // SERVER-side log only; the response is a fixed generic message.
  console.error("[api] unhandled:", error);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "internal error" } },
    { status: 500 },
  );
}

export async function parseBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AppError("request body must be valid JSON", 400, "BAD_REQUEST");
  }
}

/**
 * L6 — parse and validate QUERY parameters in ONE place.
 *
 * A missing or malformed query parameter is the CALLER's error, so the contract
 * is a structured 400 (BAD_REQUEST). Two failure modes are closed by this:
 *
 *   1. `fail(new Error("weekId query param is required"))` — a plain Error,
 *      which the Phase 9 sanitizer (correctly) turns into a generic
 *      `500 { code: "INTERNAL" }`. A server error for a client mistake, and
 *      useless to the caller.
 *   2. Passing the raw string straight into a query, where a malformed uuid,
 *      enum or integer surfaced as a driver error (`invalid input syntax for
 *      type uuid`, `limit(NaN)`) and produced the same 500.
 *
 * Callers MUST authenticate/authorize FIRST. Because authorization is then
 * decided before the parameter is read, an anonymous or forbidden caller gets
 * 401/403 as usual and learns nothing about which parameters exist or what
 * their valid ranges are.
 */
export function parseQuery<T>(req: Request, schema: ZodType<T>): T {
  const raw = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError(describeQueryIssues(parsed.error));
  return parsed.data;
}

/**
 * A safe, client-facing summary: field names plus Zod's own wording. Zod
 * messages describe the shape of the input, never the server's internals.
 */
function formatIssues(error: ZodError, fallbackField: string): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : fallbackField;
    return /received undefined/.test(issue.message) ? `${field} is required` : `${field}: ${issue.message}`;
  });
}

function describeQueryIssues(error: ZodError): string {
  const parts = formatIssues(error, "query");
  return `invalid query parameter${parts.length === 1 ? "" : "s"} — ${parts.join("; ")}`;
}

/** Same summary for a rejected REQUEST BODY, so callers can display it. */
function describeBodyIssues(error: ZodError): string {
  return `invalid request body — ${formatIssues(error, "body").join("; ")}`;
}
