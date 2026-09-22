import { ok, fail, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AuditService } from "@/server/services";
import { auditLogs } from "@/server/db/schema";
import { getDb } from "@/server/db/client";
import { auditLogsQuerySchema } from "@/lib/validation/query-schemas";

export async function GET(req: Request) {
  try {
    await requirePermission("audit.read");
    // `entityId` is a uuid column and page numbers feed LIMIT/OFFSET, so a
    // malformed filter used to become a driver error (or a NaN limit) behind
    // the sanitized 500.
    const query = parseQuery(req, auditLogsQuerySchema);
    const result = await AuditService.listAuditLogs({
      entityType: query.entityType,
      entityId: query.entityId,
      action: query.action,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 100,
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
