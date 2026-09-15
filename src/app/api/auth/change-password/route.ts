import { ok, fail, parseBody } from "@/server/api/helpers";
import { requireUser } from "@/server/auth/guard";
import { changePassword } from "@/server/auth/auth.service";
import { changePasswordSchema } from "@/lib/validation/schemas";

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = changePasswordSchema.parse(await parseBody(req));
    await changePassword(user.userId, body.currentPassword, body.newPassword);
    return ok({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
