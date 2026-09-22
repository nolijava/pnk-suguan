import { ok, fail, parseBody, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AvailabilityService } from "@/server/services";
import { availabilityQuerySchema } from "@/lib/validation/query-schemas";
import type { AvailabilityUpsertInput } from "@/lib/validation/schemas";

/**
 * GET /api/availability?weekId=… — Phase 3 weekly list envelope with
 * effective-status (§7/§8) and allowlisted filters (§10). No purokGrupo.
 */
export async function GET(req: Request) {
  try {
    await requirePermission("availability.read");
    const q = parseQuery(req, availabilityQuerySchema);
    const result = await AvailabilityService.listWeeklyAvailability(q.weekId, {
      search: q.q,
      availability: q.availability,
      masterStatus: q.masterStatus,
      language: q.language,
      currentDestinationId: q.currentDestinationId,
      sort: q.sort,
      order: q.order,
    });
    return ok({ ...result, weekId: q.weekId });
  } catch (err) {
    return fail(err);
  }
}

/** PUT /api/availability — single weekly availability upsert (Phase 1 compatible). */
export async function PUT(req: Request) {
  try {
    const user = await requirePermission("availability.write");
    const body = await parseBody<AvailabilityUpsertInput>(req);
    return ok(await AvailabilityService.upsertAvailability(body, user), 201);
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/availability — single weekly availability upsert (Phase 1 compatible). */
export async function POST(req: Request) {
  try {
    const user = await requirePermission("availability.write");
    const body = await parseBody<AvailabilityUpsertInput>(req);
    return ok(await AvailabilityService.upsertAvailability(body, user), 201);
  } catch (err) {
    return fail(err);
  }
}
