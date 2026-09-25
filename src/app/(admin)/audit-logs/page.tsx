import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { listAuditLogs } from "@/server/services/audit.service";
import { FilterForm, Pagination } from "@/app/(admin)/_components";

export const dynamic = "force-dynamic";

/** Entity types the app writes; kept here as the filter vocabulary only. */
const ENTITY_TYPES = [
  "USER",
  "TEACHER",
  "DAKO",
  "WEEK",
  "ASSIGNMENT",
  "DESTINATION",
  "NOTIFICATION",
];

/**
 * Audit log (ADMIN-only). Filters are server-side and apply automatically — the
 * old page had no filter controls at all. Read-only: the audit table is
 * append-only and nothing here writes to it.
 */
export default async function AuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("audit.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const q = typeof flat.q === "string" && flat.q.trim() ? flat.q.trim() : undefined;
  const entityType =
    typeof flat.entityType === "string" && ENTITY_TYPES.includes(flat.entityType) ? flat.entityType : undefined;
  const pageParam = Number(flat.page);
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  const { rows, total, pageCount } = await listAuditLogs({ q, entityType, page, pageSize: 50 });

  const baseSearch: Record<string, string | undefined> = { q, entityType };

  return (
    <>
      <div className="page-header">
        <div>
          <span className="eyebrow">Administration</span>
          <h1>Audit log</h1>
          <p>Immutable record of administrative actions — newest first.</p>
        </div>
        <span className="chip">{total} entr{total === 1 ? "y" : "ies"}</span>
      </div>

      <FilterForm
        action="/audit-logs"
        values={{ q, entityType }}
        fields={[
          { kind: "search", name: "q", placeholder: "Search action, entity, or reason…" },
          {
            name: "entityType",
            label: "Entity",
            options: ENTITY_TYPES.map((t) => ({ value: t, label: t })),
          },
        ]}
      />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{r.createdAt.toISOString().slice(0, 19).replace("T", " ")}</td>
                <td>
                  <span className="badge badge-blue">{r.action}</span>
                </td>
                <td>
                  {r.entityType}
                  {r.entityId ? ` · ${r.entityId.slice(0, 8)}…` : ""}
                </td>
                <td className="wrap">{r.reason ?? ""}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty-state">
                  {q || entityType ? "No audit entries match your filters." : "No audit entries yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageCount={pageCount} total={total} baseSearch={baseSearch} basePath="/audit-logs" />
    </>
  );
}
