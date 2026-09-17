import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";
import { buildAnnualSchedule } from "@/lib/annual";

/** Phase 5 — read-only annual Suguan schedule for one ISO year (§20). */
export async function GET(req: Request) {
  try {
    await requirePermission("assignments.read");
    const url = new URL(req.url);
    const year = Number(url.searchParams.get("year"));
    if (!Number.isInteger(year) || year < 1900 || year > 2999) {
      return fail(new Error("year query param must be an integer 1900–2999"));
    }
    const rows = await AssignmentService.listAssignmentsForYear(year);
    return ok(buildAnnualSchedule(rows, year));
  } catch (err) {
    return fail(err);
  }
}
