"use client";

import { useEffect, useRef } from "react";
import type { AnnualSchedule } from "@/lib/annual";

const TYPE_LABEL: Record<string, string> = {
  SUGO: "SUGO",
  RESERBA: "RESERBA",
  RESERBA_II: "RESERBA II",
};

function weekLabel(w: number): string {
  return `W${String(w).padStart(2, "0")}`;
}

export interface AnnualTablesProps {
  schedule: AnnualSchedule;
  /** `W38` when the selected year is the current ISO year — null otherwise (no false highlight, §4). */
  currentWeekKey: string | null;
  /** Always-shown current ISO week indicator, e.g. `W38 · 2026`. */
  currentIsoLabel: string;
}

/**
 * Phase 5 — the THREE SEPARATE annual tables (SUGO → RESERBA → RESERBA II),
 * vertically stacked, week-aligned via synchronized horizontal scrolling.
 * Dako column is sticky; type and source are conveyed by text, never color
 * alone (§22).
 */
export function AnnualTables({ schedule, currentWeekKey, currentIsoLabel }: AnnualTablesProps) {
  const wrapRefs = useRef<(HTMLDivElement | null)[]>([]);
  const syncing = useRef(false);

  useEffect(() => {
    const els = wrapRefs.current.filter((e): e is HTMLDivElement => e !== null);
    function onScroll(this: HTMLDivElement) {
      if (syncing.current) return;
      syncing.current = true;
      for (const el of els) {
        if (el !== this) el.scrollLeft = this.scrollLeft;
      }
      syncing.current = false;
    }
    els.forEach((el) => el.addEventListener("scroll", onScroll, { passive: true }));
    return () => els.forEach((el) => el.removeEventListener("scroll", onScroll));
  }, [schedule.year]);

  const weeks = Array.from({ length: schedule.weekCount }, (_, i) => i + 1);

  return (
    <section className="annual-section">
      <div className="annual-year-nav">
        <a className="btn btn-secondary" href={`/?year=${schedule.year - 1}`} aria-label={`Previous year ${schedule.year - 1}`}>
          ‹ {schedule.year - 1}
        </a>
        <strong>{schedule.year}</strong>
        <a className="btn btn-secondary" href={`/?year=${schedule.year + 1}`} aria-label={`Next year ${schedule.year + 1}`}>
          {schedule.year + 1} ›
        </a>
        <a className="btn btn-secondary" href="/">Today</a>
        <span className="info-note">Current ISO week: {currentIsoLabel}</span>
      </div>

      {schedule.tables.map((table, ti) => (
        <div key={table.assignmentType} className="annual-block">
          <h2>
            {TYPE_LABEL[table.assignmentType]} — {schedule.year}
          </h2>
          <div
            className="annual-scroll"
            ref={(el) => {
              wrapRefs.current[ti] = el;
            }}
            tabIndex={0}
            role="region"
            aria-label={`${TYPE_LABEL[table.assignmentType]} annual schedule ${schedule.year}`}
          >
            <table className="annual-table">
              <caption className="info-note">
                {TYPE_LABEL[table.assignmentType]} · {schedule.year} · Dako × ISO week ({schedule.weekCount} weeks)
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="dako-col">Dako</th>
                  {weeks.map((w) => (
                    <th key={w} scope="col" className={currentWeekKey === weekLabel(w) ? "current-week" : undefined}>
                      {weekLabel(w)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.dakoRows.length === 0 ? (
                  <tr>
                    <td colSpan={schedule.weekCount + 1}>No dakos with schedule data for {schedule.year}.</td>
                  </tr>
                ) : (
                  table.dakoRows.map((d) => (
                    <tr key={d.dakoId}>
                      <th scope="row" className="dako-col">
                        {d.dakoName} <span className="info-note">({d.dakoCode})</span>
                        {d.disabled ? <span className="badge badge-gray">DISABLED</span> : null}
                      </th>
                      {d.cells.map((c, i) => (
                        <td key={i} className={currentWeekKey === weekLabel(i + 1) ? "current-week" : undefined}>
                          {c.teacherName ? (
                            <>
                              {c.teacherName}
                              {c.source && c.source !== "AUTO" ? (
                                <span className="badge badge-gray">{c.source}</span>
                              ) : null}
                            </>
                          ) : (
                            <span className="info-note">—</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}
