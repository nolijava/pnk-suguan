import { NextResponse } from "next/server";
import { getDbClient } from "@/server/db/client";

/**
 * Launcher readiness probe.
 *
 * Local-only by construction: the packaged server binds to 127.0.0.1, so this
 * route is reachable from the same machine only. It is intentionally
 * unauthenticated (the launcher has no session) and therefore reports the
 * minimum needed to answer one question — "is the app up and is the database
 * reachable?" — and NOTHING else. No credentials, no connection string, no
 * version, no user data, no stack traces.
 *
 *   200 { status: "ready" }     app is serving and the database answered
 *   503 { status: "degraded" }  app is serving but the database is unreachable
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  let db = false;
  try {
    const sql = getDbClient();
    await sql`select 1 as ok`;
    db = true;
  } catch {
    // The launcher only needs the boolean; the reason stays in the server log.
    db = false;
  }

  return NextResponse.json(
    {
      status: db ? "ready" : "degraded",
      ready: db,
      db,
      uptimeSeconds: Math.round(process.uptime()),
    },
    {
      status: db ? 200 : 503,
      headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
    },
  );
}
