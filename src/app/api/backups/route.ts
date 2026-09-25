import { ok, fail } from "@/server/api/helpers";
import { ValidationError } from "@/lib/errors";
import { requirePermission } from "@/server/auth/guard";
import { createBackup, listBackups } from "@/server/services/backup.service";

/**
 * Update #18 — backup catalog + creation.
 *  GET  — list backups (backups.read; VIEWER included — read-only).
 *  POST — create a full backup (backups.write; ADMIN / SCHEDULER / SUPER_ADMIN).
 * Both operations that write are audited by the service.
 */
export async function GET() {
  try {
    await requirePermission("backups.read");
    return ok(await listBackups());
  } catch (err) {
    return fail(err);
  }
}

/**
 * Update #18+ (Backup location options) — body is optional: `{ pickToken }`
 * (from POST /api/backups/pick-destination) writes the backup to the
 * operator-chosen location. The SAME pg_dump pipeline, integrity validation,
 * metadata and audit run either way — one backup mechanism, two destinations.
 * An empty body keeps the original default-destination behavior.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePermission("backups.write");
    const raw = await req.text();
    let body: { pickToken?: string } = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw) as { pickToken?: string };
      } catch {
        throw new ValidationError("invalid JSON body");
      }
    }
    const target = body.pickToken ? { pickToken: body.pickToken } : undefined;
    return ok(await createBackup(user, "pnk-backup", target), 201);
  } catch (err) {
    return fail(err);
  }
}
