const STYLES: Record<string, string> = {
  ACTIVE: "badge badge-green",
  INACTIVE: "badge badge-gray",
  DISABLED: "badge badge-gray",
  DRAFT: "badge badge-blue",
  FINALIZED: "badge badge-amber",
  PUBLISHED: "badge badge-green",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={STYLES[status] ?? "badge badge-gray"}>{status}</span>;
}
