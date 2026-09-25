/**
 * New Update #5 — the ONE "Generate PDF" affordance every report page uses.
 *
 * A plain anchor (not next/link) on purpose: the response is a PDF attachment,
 * so a client-side route transition would be wrong and prefetching the file
 * would double the work. The link carries the page's CURRENT filters, so the
 * file always matches what the operator is looking at.
 */
export function ReportPdfButton({
  report,
  params,
  label = "Generate PDF",
}: {
  report: string;
  params?: Record<string, string | number | undefined | null>;
  label?: string;
}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return (
    <a
      className="btn btn-secondary"
      href={`/api/reports/${report}/pdf${qs ? `?${qs}` : ""}`}
      // Downloads are user-initiated; no prefetch, no client transition.
      rel="nofollow"
    >
      {label}
    </a>
  );
}
