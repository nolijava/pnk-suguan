import Link from "next/link";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  sortKey?: string;
  align?: "left" | "right";
}

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  sort,
  order,
  baseSearch,
  emptyMessage = "No records found.",
}: {
  columns: Column<T>[];
  rows: T[];
  sort?: string;
  order?: "asc" | "desc";
  baseSearch?: Record<string, string | undefined>;
  emptyMessage?: string;
}) {
  function sortHref(col: Column<T>): string | undefined {
    if (!col.sortKey || !baseSearch) return undefined;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(baseSearch)) {
      if (v) params.set(k, v);
    }
    params.set("sort", col.sortKey);
    params.set("order", sort === col.sortKey && order === "asc" ? "desc" : "asc");
    return `?${params.toString()}`;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => {
              const href = sortHref(c);
              return (
                <th key={c.key} style={{ textAlign: c.align ?? "left" }}>
                  {href ? (
                    <Link href={href} className="sort-link">
                      {c.header}
                      {sort === c.sortKey ? <span className="sort-arrow">{order === "asc" ? " ▲" : " ▼"}</span> : null}
                    </Link>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((c) => (
                <td key={c.key} className={c.key === "actions" ? "wrap" : undefined} style={{ textAlign: c.align ?? "left" }}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="empty-state">
                {emptyMessage}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
