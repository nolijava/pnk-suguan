import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AvailabilityService } from "@/server/services";
import { isAvailabilityCorrectionActive } from "@/server/services/availability.service";
import { availabilityCorrectionSchema } from "@/lib/validation/query-schemas";

/**
 * POST /api/availability/:weekId/correction — §8b ADMIN-only correction window
 * for a PUBLISHED week. Week status remains PUBLISHED; only availability
 * editing is temporarily permitted for the granting ADMIN. Audited begin/end.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ weekId: string }> },
) {
  try {
    const user = await requirePermission("availability.write");
    const { weekId } = await ctx.params;
    const body = availabilityCorrectionSchema.parse(await parseBody<unknown>(req));
    if (body.action === "begin") {
      const result = await AvailabilityService.beginAvailabilityCorrection(weekId, body.reason!, user);
      return ok({ ...result, active: true });
    }
    await AvailabilityService.endAvailabilityCorrection(weekId, user);
    return ok({ weekId, active: false });
  } catch (err) {
    return fail(err);
  }
}

/** GET /api/availability/:weekId/correction — correction-window state for the UI banner. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ weekId: string }> },
) {
  try {
    await requirePermission("availability.read");
    const { weekId } = await ctx.params;
    return ok({ weekId, active: await isAvailabilityCorrectionActive(weekId) });
  } catch (err) {
    return fail(err);
  }
}
