import { ok, fail, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { SchedulingService } from "@/server/services";
import { weekIdQuerySchema } from "@/lib/validation/query-schemas";

/** §3 — fresh (never cached) previous-week absence count for the warning dialog. */
export async function GET(req: Request) {
  try {
    await requirePermission("assignments.read");
    const { weekId } = parseQuery(req, weekIdQuerySchema);
    return ok(await SchedulingService.countPreviousWeekAbsences(weekId));
  } catch (err) {
    return fail(err);
  }
}
