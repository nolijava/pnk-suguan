import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AvailabilityService } from "@/server/services";
import { availabilityBulkSchema } from "@/lib/validation/schemas";

/** POST /api/availability/bulk — batched weekly save (§11): one transaction, per-row validation + audit. */
export async function POST(req: Request) {
  try {
    const user = await requirePermission("availability.write");
    const body = await parseBody<unknown>(req);
    return ok(await AvailabilityService.bulkSetAvailability(availabilityBulkSchema.parse(body), user));
  } catch (err) {
    return fail(err);
  }
}
