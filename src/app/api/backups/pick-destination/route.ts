import { fail, ok } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import * as backupService from "@/server/services/backup.service";

/**
 * Update #18+ — "Choose Different Location": open the native Windows Save As
 * dialog through the trusted backend and hand back a single-use pick token.
 * The browser never receives arbitrary filesystem access — the token only ever
 * refers to the one path the operator picked.
 */
export async function POST() {
  try {
    const user = await requirePermission("backups.write");
    return ok(await backupService.pickBackupDestination(user));
  } catch (e) {
    return fail(e);
  }
}
