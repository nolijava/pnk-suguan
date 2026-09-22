import { ok, fail, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";
import { buildAnnualSchedule } from "@/lib/annual";
import { annualScheduleQuerySchema } from "@/lib/validation/query-schemas";

/** Phase 5 — read-only annual Suguan schedule for one ISO year (§20). */
export async function GET(req: Request) {
  try {
    await requirePermission("assignments.read");
    // Client-input validation (400), not an internal failure: a missing or
    // malformed `year` is the caller's error, so it must never surface as a
    // sanitized 500. Authorization is still checked first (above), so an
    // anonymous or unauthorized caller gets 401/403 and learns nothing about
    // the parameter.
    const { year } = parseQuery(req, annualScheduleQuerySchema);
    const rows = await AssignmentService.listAssignmentsForYear(year);
    return ok(buildAnnualSchedule(rows, year));
  } catch (err) {
    return fail(err);
  }
}
