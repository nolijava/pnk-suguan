/**
 * Shared status badge. Presentation only — the label shown is always the exact
 * status/source value passed in; only the visual treatment varies by meaning.
 * Colour is never the sole signal (the text itself carries the state).
 */
const STYLES: Record<string, string> = {
  // Teacher / Dako master status
  ACTIVE: "badge badge-green",
  INACTIVE: "badge badge-gray",
  DISABLED: "badge badge-gray",
  // Week lifecycle
  DRAFT: "badge badge-blue",
  FINALIZED: "badge badge-amber",
  PUBLISHED: "badge badge-green",
  // Weekly availability
  AVAILABLE: "badge badge-green",
  ABSENT: "badge badge-red",
  INACTIVE_WEEKLY: "badge badge-gray",
  INACTIVE_MASTER: "badge badge-gray",
  NOT_ENCODED: "badge badge-gray",
  // Assignment source
  AUTO: "badge badge-blue",
  MANUAL: "badge badge-gray",
  OVERRIDE: "badge badge-amber",
  HISTORICAL: "badge badge-historical",
  // Cell provenance
  UPDATED: "badge badge-updated",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={STYLES[status] ?? "badge badge-gray"}>{status}</span>;
}
