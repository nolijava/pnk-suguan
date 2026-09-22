/**
 * Phase 5 — pure annual Suguan schedule builder.
 * Consumes year-assignment rows from the single batched DB query and produces
 * the THREE INDEPENDENT annual tables (SUGO → RESERBA → RESERBA II), one Dako ×
 * ISO-week grid per type — never one merged matrix. No DB access, no writes,
 * deterministic; the dashboard renders this shape directly.
 */
import { isoWeeksInYear } from "./iso-week";

export const ANNUAL_TYPES = ["SUGO", "RESERBA", "RESERBA_II"] as const;
export type AnnualTypeCode = (typeof ANNUAL_TYPES)[number];

/** One flat row from the batched year query (AssignmentService.listAssignmentsForYear). */
export interface AnnualAssignmentRow {
  id: string;
  weekNumber: number;
  /** The lifecycle status of the week this row belongs to (Group 4 gating). */
  weekStatus?: string;
  dakoId: string;
  dakoCode: string;
  dakoName: string;
  dakoStatus: string;
  assignmentType: string;
  assignmentSource: string;
  status: string;
  teacherId: string | null;
  teacherName: string | null;
  teacherCode: string | null;
}

export interface AnnualCell {
  /** Assignment row id — null when the slot is empty (or fully cleared). */
  id: string | null;
  teacherName: string | null;
  teacherCode: string | null;
  source: string | null;
  status: string | null;
}

export interface AnnualDakoRow {
  dakoId: string;
  dakoCode: string;
  dakoName: string;
  /** DISABLED dako kept visible only for historical context (§6) — never removed. */
  disabled: boolean;
  /** Index = weekNumber − 1; every cell present (teacher null ⇒ render "—"). */
  cells: AnnualCell[];
}

export interface AnnualTable {
  assignmentType: AnnualTypeCode;
  dakoRows: AnnualDakoRow[];
}

export interface AnnualSchedule {
  year: number;
  /** Real ISO week count — 52 or 53 via isoWeeksInYear; never invented. */
  weekCount: number;
  /**
   * ISO week number → that week's lifecycle status, for EVERY week of the year
   * (supplied by the caller so weeks without assignments are still covered).
   * Presentation-only: the scheduler and the server remain authoritative.
   */
  weekStatusByNumber: Record<number, string>;
  tables: [AnnualTable, AnnualTable, AnnualTable];
}

export function buildAnnualSchedule(
  rows: AnnualAssignmentRow[],
  year: number,
  weekStatuses: { isoWeekNumber: number; status: string }[] = [],
): AnnualSchedule {
  const weekCount = isoWeeksInYear(year);
  const weekStatusByNumber: Record<number, string> = {};
  for (const w of weekStatuses) weekStatusByNumber[w.isoWeekNumber] = w.status;
  for (const r of rows) {
    if (r.weekStatus && weekStatusByNumber[r.weekNumber] === undefined) {
      weekStatusByNumber[r.weekNumber] = r.weekStatus;
    }
  }

  // Dako master rows seen in the year's data (ACTIVE first-class; a dako that
  // has ANY active-week row is treated as ACTIVE), ordered by dakoCode.
  const dakoMeta = new Map<string, { dakoCode: string; dakoName: string; disabled: boolean }>();
  for (const r of rows) {
    const existing = dakoMeta.get(r.dakoId);
    if (existing) {
      existing.disabled = existing.disabled && r.dakoStatus !== "ACTIVE";
    } else {
      dakoMeta.set(r.dakoId, {
        dakoCode: r.dakoCode,
        dakoName: r.dakoName,
        disabled: r.dakoStatus !== "ACTIVE",
      });
    }
  }
  const metas = [...dakoMeta.entries()].sort(
    ([, a], [, b]) => a.dakoCode.localeCompare(b.dakoCode) || a.dakoName.localeCompare(b.dakoName),
  );

  // Assigned cell lookup — only real rows create cells.
  const cellKey = (dakoId: string, weekNumber: number, type: string) => `${dakoId}|${weekNumber}|${type}`;
  const assigned = new Map<string, AnnualAssignmentRow>();
  for (const r of rows) {
    if (r.teacherId) assigned.set(cellKey(r.dakoId, r.weekNumber, r.assignmentType), r);
  }

  const buildTable = (type: AnnualTypeCode): AnnualTable => ({
    assignmentType: type,
    dakoRows: metas.map(([dakoId, meta]) => ({
      dakoId,
      dakoCode: meta.dakoCode,
      dakoName: meta.dakoName,
      disabled: meta.disabled,
      cells: Array.from({ length: weekCount }, (_, i) => {
        const hit = assigned.get(cellKey(dakoId, i + 1, type));
        return hit
          ? {
              id: hit.id,
              teacherName: hit.teacherName,
              teacherCode: hit.teacherCode,
              source: hit.assignmentSource,
              status: hit.status,
            }
          : { id: null, teacherName: null, teacherCode: null, source: null, status: null };
      }),
    })),
  });

  return {
    year,
    weekCount,
    weekStatusByNumber,
    tables: [buildTable("SUGO"), buildTable("RESERBA"), buildTable("RESERBA_II")],
  };
}
