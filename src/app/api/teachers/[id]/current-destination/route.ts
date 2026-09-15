import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { TeacherService } from "@/server/services";
import { currentDestinationChangeSchema } from "@/lib/validation/query-schemas";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const user = await requirePermission("teachers.write");
    const { id } = await params;
    const body = currentDestinationChangeSchema.parse(await parseBody(req));
    const result = await TeacherService.changeCurrentDestination(id, body.newDestinationId, body.reason, user);
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
