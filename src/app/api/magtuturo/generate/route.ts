import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import {
  generateMagtuturoWeek,
  generateMagtuturoMonth,
} from "@/server/services/magtuturo.service";

/**
 * Update #21.11 — generation period option.
 * { mode: "week", weekId }    → regular weekly generation (4 SUGO + 2 RESERBA)
 * { mode: "month", year, month } → month generated week-by-week
 */
export async function POST(req: Request) {
  try {
    const user = await requirePermission("scheduling.generate");
    const body = await parseBody<
      | { mode: "week"; weekId: string }
      | { mode: "month"; year: number; month: number }
    >(req);
    if (body.mode === "month") {
      return ok(await generateMagtuturoMonth(body.year, body.month, user));
    }
    return ok(await generateMagtuturoWeek(body.weekId, user));
  } catch (err) {
    return fail(err);
  }
}
