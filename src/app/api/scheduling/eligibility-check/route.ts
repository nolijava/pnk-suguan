import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { SchedulingService } from "@/server/services";
import type { EligibilityCheckPayload } from "@/lib/validation/schemas";

/** §15 — which hard rules (if any) a proposed (week, dako, teacher) violates. */
export async function POST(req: Request) {
  try {
    await requirePermission("assignments.write");
    const body = await parseBody<EligibilityCheckPayload>(req);
    return ok(await SchedulingService.checkEligibility(body));
  } catch (err) {
    return fail(err);
  }
}
