import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AvailabilityService } from "@/server/services";
import type { AvailabilityUpsertInput } from "@/lib/validation/schemas";

export async function GET(req: Request) {
  try {
    await requirePermission("availability.read");
    const url = new URL(req.url);
    const weekId = url.searchParams.get("weekId");
    if (!weekId) return fail(new Error("weekId query param is required"));
    return ok(await AvailabilityService.listAvailabilityForWeek(weekId));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requirePermission("availability.write");
    const body = await parseBody<AvailabilityUpsertInput>(req);
    return ok(await AvailabilityService.upsertAvailability(body, user), 201);
  } catch (err) {
    return fail(err);
  }
}
