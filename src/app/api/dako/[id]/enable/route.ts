import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { DakoService } from "@/server/services";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  try {
    const user = await requirePermission("dako.write");
    const { id } = await params;
    return ok(await DakoService.enableDako(id, user));
  } catch (err) {
    return fail(err);
  }
}
