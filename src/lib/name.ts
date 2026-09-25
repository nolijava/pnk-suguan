/**
 * Update #3/#12 — Guro display-name formatting (presentation only).
 *
 * Stored name parts are NEVER modified; only what a screen PRINTS is composed
 * here. One source of truth so every surface (lists, pickers, schedule,
 * dashboard, PDF, notices, destination/history) formats names identically.
 */

export interface NameParts {
  firstName: string;
  middleName?: string | null;
  lastName: string;
  suffix?: string | null;
}

/**
 * Full display name — `Juan Dela Cruz, Jr.`.
 * The suffix is ALWAYS comma-separated (`Juan Cruz, Jr.`), never glued on.
 */
export function formatFullName(p: NameParts): string {
  const core = [p.firstName, p.middleName, p.lastName]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const suffix = (p.suffix ?? "").trim();
  return suffix ? `${core}, ${suffix}` : core;
}

/**
 * Update #12 — Dashboard-only form: MIDDLE NAME HIDDEN, suffix kept.
 * `Juan Dela Cruz, Jr.` -> `Juan Cruz, Jr.`. Display-layer rule only.
 */
export function formatDashboardName(p: NameParts): string {
  const core = [p.firstName, p.lastName]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const suffix = (p.suffix ?? "").trim();
  return suffix ? `${core}, ${suffix}` : core;
}
