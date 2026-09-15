import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { DakoService } from "@/server/services";

export async function GET() {
  try {
    await requirePermission("dako.read");
    return ok(await DakoService.listDakoPurokGroups());
  } catch (err) {
    return fail(err);
  }
}
