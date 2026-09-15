import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AuditService } from "@/server/services";
import { auditLogs } from "@/server/db/schema";
import { getDb } from "@/server/db/client";

export async function GET(req: Request) {
  try {
    await requirePermission("audit.read");
    const url = new URL(req.url);
    const result = await AuditService.listAuditLogs({
      entityType: url.searchParams.get("entityType") ?? undefined,
      entityId: url.searchParams.get("entityId") ?? undefined,
      action: url.searchParams.get("action") ?? undefined,
      page: Number(url.searchParams.get("page") ?? 1),
      pageSize: Number(url.searchParams.get("pageSize") ?? 100),
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/** §28 append-only proof: any UPDATE/DELETE attempt on audit_logs must fail. */
export async function DELETE() {
  try {
    await requirePermission("audit.read");
    await getDb().update(auditLogs).set({ reason: "tamper" });
    return ok({ tampered: true });
  } catch (err) {
    return fail(err);
  }
}
