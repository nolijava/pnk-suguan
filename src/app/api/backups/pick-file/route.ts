import { fail, ok } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import * as backupService from "@/server/services/backup.service";

/**
 * Update #18+ — "Restore from other location": open the native Windows Open
 * dialog through the trusted backend (any local drive/folder, not just the
 * default backups directory). The picked file is inspected read-only and
 * returned with a one-shot pick token; it stays UNTRUSTED until the restore
 * pipeline re-validates it server-side.
 */
export async function POST() {
  try {
    const user = await requirePermission("backups.restore");
    return ok(await backupService.pickRestoreFile(user));
  } catch (e) {
    return fail(e);
  }
}
