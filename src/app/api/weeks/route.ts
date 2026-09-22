import { ok, fail, parseBody, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { WeekService } from "@/server/services";
import { weeksQuerySchema } from "@/lib/validation/query-schemas";

export async function GET(req: Request) {
  try {
    await requirePermission("weeks.read");
    // `year` stays optional; when supplied it must be a real year. A malformed
    // value used to become NaN, which is falsy — so the UNFILTERED list came
    // back as though no filter had been requested at all.
    const { year } = parseQuery(req, weeksQuerySchema);
    return ok(await WeekService.listWeeks(year));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requirePermission("weeks.write");
    const body = await parseBody<{ year: number; isoWeekNumber: number }>(req);
    return ok(await WeekService.createWeek(body, user), 201);
  } catch (err) {
    return fail(err);
  }
}
