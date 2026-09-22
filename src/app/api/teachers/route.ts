import { ok, fail, parseBody, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { TeacherService } from "@/server/services";
import type { TeacherCreateInput } from "@/lib/validation/schemas";
import { teacherQuerySchema } from "@/lib/validation/query-schemas";

export async function GET(req: Request) {
  try {
    await requirePermission("teachers.read");
    const query = parseQuery(req, teacherQuerySchema);
    return ok(
      await TeacherService.listTeachers({
        search: query.q,
        status: query.status,
        language: query.language,
        currentDestinationId: query.currentDestinationId,
        sort: query.sort,
        order: query.order,
        page: query.page,
        pageSize: query.pageSize,
      }),
    );
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requirePermission("teachers.write");
    const body = await parseBody<TeacherCreateInput>(req);
    const row = await TeacherService.createTeacher(body, user);
    return ok(row, 201);
  } catch (err) {
    return fail(err);
  }
}
