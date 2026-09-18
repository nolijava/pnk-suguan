import { StatusBadge } from "../_components/status-badge";

export { StatusBadge };

/** Text source badge — AUTO/MANUAL/OVERRIDE/HISTORICAL, never color alone. */
export function ReportSourceBadge({ source }: { source: string }) {
  return (
    <span className={source === "HISTORICAL" ? "badge badge-historical" : "badge badge-gray"}>
      {source}
    </span>
  );
}

/** Deterministic `YYYY-MM-DD HH:mm UTC` rendering for report timestamps. */
export function fmtUtc(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
