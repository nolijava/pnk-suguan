import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { SchedulingService } from "@/server/services";

/** §3 — fresh (never cached) previous-week absence count for the warning dialog. */
export async function GET(req: Request) {
  try {
    await requirePermission("assignments.read");
    const weekId = new URL(req.url).searchParams.get("weekId");
    if (!weekId) return fail(new Error("weekId query param is required"));
    return ok(await SchedulingService.countPreviousWeekAbsences(weekId));
  } catch (err) {
    return fail(err);
  }
}
