import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { NotificationService } from "@/server/services";

/**
 * Phase 8 — ADMIN-only operational/testing trigger for the SAME idempotent
 * anniversary scan the instrumentation timer runs (~every 6h). No separate
 * notification logic; DB dedupe keeps repeated calls harmless.
 */
export async function POST() {
  try {
    await requirePermission("notifications.write");
    return ok(await NotificationService.runDueAnniversaryScan());
  } catch (err) {
    return fail(err);
  }
}
