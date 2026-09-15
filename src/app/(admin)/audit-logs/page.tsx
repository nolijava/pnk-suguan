import { requirePermission } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { auditLogs } from "@/server/db/schema";
import { desc } from "drizzle-orm";

export default async function AuditLogsPage() {
  await requirePermission("audit.read");
  const rows = await getDb()
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);

  return (
    <>
      <h1>Audit log</h1>
      <table>
        <thead>
          <tr><th>When</th><th>Action</th><th>Entity</th><th>Reason</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.createdAt.toISOString().slice(0, 19).replace("T", " ")}</td>
              <td>{r.action}</td>
              <td>{r.entityType}{r.entityId ? ` · ${r.entityId.slice(0, 8)}…` : ""}</td>
              <td>{r.reason ?? ""}</td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td colSpan={4}>No audit entries yet.</td></tr> : null}
        </tbody>
      </table>
    </>
  );
}
