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
      <div className="page-header">
        <div>
          <span className="eyebrow">Administration</span>
          <h1>Audit log</h1>
          <p>Immutable record of administrative actions — newest first.</p>
        </div>
        <span className="chip">{rows.length} recent entries</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>When</th><th>Action</th><th>Entity</th><th>Reason</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{r.createdAt.toISOString().slice(0, 19).replace("T", " ")}</td>
                <td><span className="badge badge-blue">{r.action}</span></td>
                <td>{r.entityType}{r.entityId ? ` · ${r.entityId.slice(0, 8)}…` : ""}</td>
                <td className="wrap">{r.reason ?? ""}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty-state">No audit entries yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
