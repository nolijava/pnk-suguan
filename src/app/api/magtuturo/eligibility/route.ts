import { ok, fail, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { weekIdQuerySchema } from "@/lib/validation/query-schemas";
import { magtuturoEligibility } from "@/server/services/magtuturo.service";

export async function GET(req: Request) {
  try {
    await requirePermission("assignments.read");
    const { weekId } = parseQuery(req, weekIdQuerySchema);
    return ok(await magtuturoEligibility(weekId));
  } catch (err) {
    return fail(err);
  }
}
