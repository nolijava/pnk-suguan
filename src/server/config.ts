/**
 * Master Consolidated Plan (E-4) — runtime configuration.
 *
 * SCHEDULING_GO_LIVE: the first week processed by the NORMAL scheduling
 * workflow. Weeks strictly before go-live belong to the Historical Backfill
 * workflow (source HISTORICAL). Configurable via SCHEDULING_GO_LIVE env
 * ("YYYY-Www", ISO week string); default 2026-W38 per approved decision.
 * Never hard-code W38 elsewhere.
 */
import { isoWeeksInYear } from "@/lib/iso-week";

export interface GoLiveWeek {
  year: number;
  week: number;
}

function parseGoLive(raw: string): GoLiveWeek {
  const m = /^(\d{4})-W(\d{2})$/.exec(raw.trim());
  if (!m) {
    throw new Error(`invalid SCHEDULING_GO_LIVE "${raw}"; expected YYYY-Www (e.g. 2026-W38)`);
  }
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > isoWeeksInYear(year)) {
    throw new Error(`invalid SCHEDULING_GO_LIVE "${raw}"; W${week} does not exist in ${year}`);
  }
  return { year, week };
}

const RAW_GO_LIVE = process.env.SCHEDULING_GO_LIVE ?? "2026-W38";

export const SCHEDULING_GO_LIVE: GoLiveWeek = parseGoLive(RAW_GO_LIVE);

/** True when the week is processed by the NORMAL scheduling workflow. */
export function isNormalSchedulingWeek(year: number, week: number): boolean {
  if (year > SCHEDULING_GO_LIVE.year) return true;
  if (year < SCHEDULING_GO_LIVE.year) return false;
  return week >= SCHEDULING_GO_LIVE.week;
}
