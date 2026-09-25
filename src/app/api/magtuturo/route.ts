import { ok, fail, parseBody, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { weekIdQuerySchema } from "@/lib/validation/query-schemas";
import {
  listMagtuturoForWeek,
  assignMagtuturo,
  clearMagtuturo,
  type MagType,
} from "@/server/services/magtuturo.service";

export async function GET(req: Request) {
  try {
    await requirePermission("assignments.read");
    const { weekId } = parseQuery(req, weekIdQuerySchema);
    return ok(await listMagtuturoForWeek(weekId));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requirePermission("assignments.write");
    const body = await parseBody<{
      weekId: string;
      teacherId: string;
      magType: MagType;
      seat?: number;
      reason?: string | null;
      isOverride?: boolean;
    }>(req);
    const result = await assignMagtuturo({ ...body, user });
    if (!result.ok) return ok(result, 422);
    return ok(result, 201);
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requirePermission("assignments.write");
    const body = await parseBody<{
      weekId: string;
      magType: MagType;
      seat: number;
      reason?: string | null;
    }>(req);
    await clearMagtuturo({ ...body, user });
    return ok({ cleared: true });
  } catch (err) {
    return fail(err);
  }
}
