import { ok, fail } from "@/server/api/helpers";
import { currentUserOrNull } from "@/server/auth/guard";

export async function GET() {
  try {
    const user = await currentUserOrNull();
    return ok({ user });
  } catch (err) {
    return fail(err);
  }
}
