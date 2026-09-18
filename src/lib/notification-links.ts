/**
 * Phase 8 — notification → page navigation (Part M). Pure mapping shared by
 * the notification bell UI; read-only, no scheduling side effects.
 */
export function notificationHref(
  relatedEntityType: string | null | undefined,
  relatedEntityId: string | null | undefined,
): string | null {
  switch (relatedEntityType) {
    case "dako":
      return relatedEntityId ? `/dako/${relatedEntityId}` : "/dako";
    case "week":
      return "/schedule";
    case "teacher":
      return relatedEntityId ? `/teachers/${relatedEntityId}` : "/teachers";
    default:
      return null;
  }
}

/** Human-readable notification category label. */
export function notificationTypeLabel(type: string): string {
  switch (type) {
    case "ONE_MONTH_BEFORE":
      return "Anniversary · 1 month";
    case "APPROACHING":
      return "Anniversary · approaching";
    case "ONE_DAY_BEFORE":
      return "Anniversary · tomorrow";
    case "TODAY":
      return "Anniversary · today";
    default:
      return type;
  }
}

/** Compact relative timestamp for the panel ("just now", "5m", "3h", "2d"). */
export function relativeTime(iso: string | Date, now: Date = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const ms = now.getTime() - d.getTime();
  if (Number.isNaN(ms)) return String(iso);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}
