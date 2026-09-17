import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import {
  recordHistoricalAssignments,
  correctHistoricalAssignment,
  listHistoricalWeeks,
  goLive,
} from "@/server/services/historical.service";
import { historicalBatchSchema, historicalCorrectionSchema } from "@/lib/validation/query-schemas";

/**
 * GET /api/assignments/historical — pre-go-live weeks for the backfill UI
 * (never exposed through the normal Generate workflow).
 */
export async function GET() {
  try {
    await requirePermission("assignments.read");
    return ok({ goLive: goLive(), weeks: await listHistoricalWeeks() });
  } catch (err) {
    return fail(err);
  }
}

/**
 * POST /api/assignments/historical — batch-record historical assignments.
 * Server-enforced: only pre-go-live weeks; no normal-cycle mixing; language
 * rule enforced; master data untouched; HISTORICAL source forever.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePermission("assignments.write");
    const body = historicalBatchSchema.parse(await parseBody<unknown>(req));
    return ok(await recordHistoricalAssignments(body.weekId, body.rows, user), 201);
  } catch (err) {
    return fail(err);
  }
}

/**
 * PATCH /api/assignments/historical — ADMIN correction of a recorded row
 * (mandatory reason; audited; source stays HISTORICAL).
 */
export async function PATCH(req: Request) {
  try {
    const user = await requirePermission("assignments.write");
    const body = historicalCorrectionSchema.parse(await parseBody<unknown>(req));
    return ok(await correctHistoricalAssignment(body, body.reason, user));
  } catch (err) {
    return fail(err);
  }
}
