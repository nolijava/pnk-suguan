import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { WeekService } from "@/server/services";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const user = await requirePermission("weeks.write");
    const { id } = await params;
    const body = await parseBody<{ status: string; reason?: string }>(req);
    return ok(await WeekService.setWeekStatus(id, body, user));
  } catch (err) {
    return fail(err);
  }
}
