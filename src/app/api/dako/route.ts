import { ok, fail, parseBody, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { DakoService } from "@/server/services";
import type { DakoCreateInput } from "@/lib/validation/schemas";
import { dakoQuerySchema } from "@/lib/validation/query-schemas";

export async function GET(req: Request) {
  try {
    await requirePermission("dako.read");
    const query = parseQuery(req, dakoQuerySchema);
    return ok(
      await DakoService.listDako({
        search: query.q,
        status: query.status,
        language: query.language,
        isPriority: query.isPriority,
        worshipDay: query.worshipDay,
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
    const user = await requirePermission("dako.write");
    const body = await parseBody<DakoCreateInput>(req);
    return ok(await DakoService.createDako(body, user), 201);
  } catch (err) {
    return fail(err);
  }
}
