import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { SchedulingService } from "@/server/services";
import type { ScheduleGenerateInput } from "@/lib/validation/schemas";

/** §6 — dry-run slot plan (no writes). Same hard rules/scoring as generation. */
export async function POST(req: Request) {
  try {
    await requirePermission("assignments.read");
    const body = await parseBody<ScheduleGenerateInput>(req);
    return ok(await SchedulingService.previewSchedule(body.weekId));
  } catch (err) {
    return fail(err);
  }
}
