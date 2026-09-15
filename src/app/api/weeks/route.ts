import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { WeekService } from "@/server/services";

export async function GET(req: Request) {
  try {
    await requirePermission("weeks.read");
    const url = new URL(req.url);
    const year = url.searchParams.get("year");
    return ok(await WeekService.listWeeks(year ? Number(year) : undefined));
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
