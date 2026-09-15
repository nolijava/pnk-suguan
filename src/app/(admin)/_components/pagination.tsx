import Link from "next/link";

export function Pagination({
  page,
  pageCount,
  total,
  baseSearch,
  basePath,
}: {
  page: number;
  pageCount: number;
  total: number;
  baseSearch: Record<string, string | undefined>;
  basePath: string;
}) {
  if (pageCount <= 1) {
    return <p className="page-info">{total} record{total === 1 ? "" : "s"}</p>;
  }
  const href = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(baseSearch)) if (v) params.set(k, v);
    params.set("page", String(p));
    return `${basePath}?${params.toString()}`;
  };
  const window: number[] = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pageCount, page + 2); p++) window.push(p);

  return (
    <div className="page-info">
      <span>
        Page {page} of {pageCount} · {total} records
      </span>
      {page > 1 ? <Link className="btn btn-secondary" href={href(page - 1)}>‹ Prev</Link> : null}
      {window.map((p) => (
        <Link key={p} className={`btn ${p === page ? "btn-primary" : "btn-secondary"}`} href={href(p)}>
          {p}
        </Link>
      ))}
      {page < pageCount ? <Link className="btn btn-secondary" href={href(page + 1)}>Next ›</Link> : null}
    </div>
  );
}
