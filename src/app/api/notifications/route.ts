import { ok, fail, parseBody } from "@/server/api/helpers";
import { requireUser } from "@/server/auth/guard";
import { NotificationService } from "@/server/services";
import { notificationReadSchema } from "@/lib/validation/schemas";

export async function GET() {
  try {
    const user = await requireUser();
    return ok(await NotificationService.listNotificationsForUser(user.userId));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = notificationReadSchema.parse(await parseBody(req));
    const n = await NotificationService.markNotificationsRead(user.userId, body.notificationIds);
    return ok({ marked: n });
  } catch (err) {
    return fail(err);
  }
}
