import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AvailabilityService } from "@/server/services";
import { availabilityFillBlanksSchema } from "@/lib/validation/schemas";

/**
 * GET /api/availability/fill-blanks?weekId=… — count of teachers Fill Blanks
 * would target (master-ACTIVE with no record for the week). Powers the UI
 * confirmation dialog, which must state the exact record count.
 */
export async function GET(req: Request) {
  try {
    await requirePermission("availability.read");
    const url = new URL(req.url);
    const parsed = availabilityFillBlanksSchema.parse(Object.fromEntries(url.searchParams.entries()));
    return ok({ weekId: parsed.weekId, count: await AvailabilityService.countFillBlankTargets(parsed.weekId) });
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/availability/fill-blanks — create AVAILABLE records for unencoded active teachers only (§11). */
export async function POST(req: Request) {
  try {
    const user = await requirePermission("availability.write");
    const body = availabilityFillBlanksSchema.parse(await req.json());
    return ok(await AvailabilityService.fillBlanksAsAvailable(body.weekId, user), 201);
  } catch (err) {
    return fail(err);
  }
}
