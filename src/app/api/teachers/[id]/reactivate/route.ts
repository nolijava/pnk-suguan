import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { TeacherService } from "@/server/services";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  try {
    const user = await requirePermission("teachers.write");
    const { id } = await params;
    return ok(await TeacherService.reactivateTeacher(id, user));
  } catch (err) {
    return fail(err);
  }
}
