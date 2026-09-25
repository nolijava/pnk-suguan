import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { restoreBackup, restoreFromFile } from "@/server/services/backup.service";

/**
 * Update #18 — restore a backup. Destructive; five independent guards apply
 * (see backup.service.ts): RBAC here (backups.restore — ADMIN / SUPER_ADMIN;
 * VIEWER can never restore), typed file-name confirmation, archive integrity
 * validation, an automatic pre-restore safety backup, and the local-PNK
 * target-database guard. Audited on success and failure.
 *
 * Update #18+ (Restore from other location) — two sources, one guarded
 * pipeline:
 *  - `{ filename, confirm }`  — a backup from the default backups folder.
 *  - `{ pickToken, confirm }` — a backup picked from ANOTHER local location
 *    (POST /api/backups/pick-file). Untrusted input until re-validated.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePermission("backups.restore");
    const body = await parseBody<{ filename?: string; pickToken?: string; confirm: string }>(req);
    if (body.pickToken) {
      return ok(await restoreFromFile(user, { pickToken: body.pickToken, confirm: body.confirm }));
    }
    return ok(await restoreBackup(user, { filename: body.filename ?? "", confirm: body.confirm }));
  } catch (err) {
    return fail(err);
  }
}
