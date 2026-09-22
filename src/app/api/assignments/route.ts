import { ok, fail, parseBody, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";
import type { AssignmentCreateInput } from "@/lib/validation/schemas";
import { weekIdQuerySchema } from "@/lib/validation/query-schemas";

export async function GET(req: Request) {
  try {
    await requirePermission("assignments.read");
    // Authorization ran first (above), so a missing or malformed `weekId` is
    // the caller's error (400) — never the sanitized 500 it used to produce.
    const { weekId } = parseQuery(req, weekIdQuerySchema);
    return ok(await AssignmentService.listAssignmentsForWeek(weekId));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requirePermission("assignments.write");
    const body = await parseBody<AssignmentCreateInput>(req);
    const result = await AssignmentService.createAssignment(body, user);
    return ok(result, 201);
  } catch (err) {
    return fail(err);
  }
}
