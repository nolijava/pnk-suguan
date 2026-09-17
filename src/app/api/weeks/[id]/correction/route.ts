import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import {
  beginFinalizedCorrection,
  beginPublishedCorrection,
  endScheduleCorrection,
  getScheduleCorrectionState,
} from "@/server/services/correction.service";
import { scheduleCorrectionSchema } from "@/lib/validation/query-schemas";

/**
 * POST /api/weeks/:weekId/correction — Master plan E-1/E-2.
 *
 *   mode=FINALIZED  → ADMIN authorized correction (weeks.unlock + reason).
 *   mode=PUBLISHED  → SUPER_ADMIN emergency unlock (role + server-verified
 *                     secret + reason). Week status never changes in either
 *                     mode; grants are scoped to this week and TTL-expire.
 *
 * The secret is accepted only in the request body — never in URLs, never
 * logged, never returned.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePermission("assignments.write");
    const { id: weekId } = await ctx.params;
    const body = scheduleCorrectionSchema.parse(await parseBody<unknown>(req));
    if (body.mode === "FINALIZED") {
      if (body.action === "begin") {
        const result = await beginFinalizedCorrection(weekId, body.reason!, user);
        return ok({ ...result, active: true });
      }
      await endScheduleCorrection(weekId, user);
      return ok({ weekId, active: false });
    }
    // PUBLISHED — SUPER_ADMIN unlock.
    if (body.action === "begin") {
      const result = await beginPublishedCorrection(weekId, body.secret!, body.reason!, user);
      return ok({ ...result, active: true });
    }
    await endScheduleCorrection(weekId, user);
    return ok({ weekId, active: false });
  } catch (err) {
    return fail(err);
  }
}

/** GET — correction-window state for the UI banner. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission("assignments.read");
    const { id: weekId } = await ctx.params;
    return ok({ weekId, ...(await getScheduleCorrectionState(weekId)) });
  } catch (err) {
    return fail(err);
  }
}
