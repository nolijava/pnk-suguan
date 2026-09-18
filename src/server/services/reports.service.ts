/**
 * Phase 8 — REPORTS (Part F/G): read-only operational reporting over the
 * EXISTING data model. Every function is a pure set-based SELECT — no
 * mutations of assignments, availability, audit, weeks (a missing week is
 * reported as "not started", never auto-created), destination history, or
 * master data (Invariants 15/16). HISTORICAL rows are reported with their
 * real source — never remapped (Invariant 14). No scheduling logic lives
 * here; unassigned reason codes are read from the engine's plan/preview,
 * which is itself a read-only computation over persisted data.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { assignments, dako, teachers, weeks } from "@/server/db/schema";
import { isoWeeksInYear } from "@/lib/iso-week";

const teacherName = sql<string>`trim(concat(${teachers.firstName}, ' ', coalesce(${teachers.middleName}, ''), ' ', ${teachers.lastName}))`;

export const REPORT_SOURCE_CODES = ["AUTO", "MANUAL", "OVERRIDE", "HISTORICAL"] as const;
export const REPORT_TYPE_CODES = ["SUGO", "RESERBA", "RESERBA_II"] as const;
export type ReportTypeCode = (typeof REPORT_TYPE_CODES)[number];

export interface ReportRow {
  assignmentId: string;
  weekNumber: number;
  year: number;
  dakoId: string;
  dakoName: string;
  assignmentType: string;
  assignmentSource: string;
  status: string;
  teacherId: string | null;
  teacherCode: string | null;
  teacherName: string | null;
  assignedAt: Date;
}

function baseRows() {
  return getDb()
    .select({
      assignmentId: assignments.id,
      weekNumber: weeks.isoWeekNumber,
      year: weeks.year,
      dakoId: assignments.dakoId,
      dakoName: dako.name,
      dakoCode: dako.dakoCode,
      assignmentType: assignments.assignmentType,
      assignmentSource: assignments.assignmentSource,
      status: assignments.status,
      teacherId: assignments.teacherId,
      teacherCode: teachers.teacherCode,
      teacherName,
      assignedAt: assignments.assignedAt,
    })
    .from(assignments)
    .innerJoin(weeks, eq(weeks.id, assignments.weekId))
    .innerJoin(dako, eq(dako.id, assignments.dakoId))
    .innerJoin(teachers, eq(teachers.id, assignments.teacherId));
}

// ---------------------------------------------------------------------------
// A. Annual type report (SUGO / RESERBA / RESERBA II) — per-Dako rows
// ---------------------------------------------------------------------------

export interface AnnualTypeReport {
  year: number;
  assignmentType: ReportTypeCode;
  isoWeeks: number;
  rows: (ReportRow & { dakoCode: string })[];
  summary: {
    totalAssigned: number;
    bySource: Record<string, number>;
    dakosCovered: number;
    weeksCovered: number;
  };
}

export async function annualTypeReport(
  year: number,
  assignmentType: ReportTypeCode,
): Promise<AnnualTypeReport> {
  const rows = await baseRows()
    .where(and(eq(weeks.year, year), eq(assignments.assignmentType, assignmentType)))
    .orderBy(asc(dako.dakoCode), asc(weeks.isoWeekNumber));

  const bySource: Record<string, number> = {};
  const dakos = new Set<string>();
  const weekSet = new Set<number>();
  for (const r of rows) {
    if (r.status === "ASSIGNED") bySource[r.assignmentSource] = (bySource[r.assignmentSource] ?? 0) + 1;
    dakos.add(r.dakoId);
    weekSet.add(r.weekNumber);
  }
  return {
    year,
    assignmentType,
    isoWeeks: isoWeeksInYear(year),
    rows: rows.map((r) => ({ ...r })),
    summary: {
      totalAssigned: Object.values(bySource).reduce((a, b) => a + b, 0),
      bySource,
      dakosCovered: dakos.size,
      weeksCovered: weekSet.size,
    },
  };
}

// ---------------------------------------------------------------------------
// B. Weekly report — A/B/C sections with unassigned reason codes
// ---------------------------------------------------------------------------

export interface WeeklyReportSlot {
  dakoId: string;
  dakoName: string;
  assignmentType: string;
  assignmentId: string | null;
  teacherName: string | null;
  teacherCode: string | null;
  source: string | null;
  status: string | null;
  reasonCode: string | null;
  reason: string | null;
}

export interface WeeklyReport {
  week: { id: string; year: number; weekNumber: number; startDate: string; endDate: string; status: string } | null;
  /** Null when the week has not been started (reported, never auto-created). */
  sections: { type: ReportTypeCode; label: string; slots: WeeklyReportSlot[] }[];
  summary: { assigned: number; unassigned: number; bySource: Record<string, number> } | null;
  note: string | null;
}

export async function weeklyReport(year: number, weekNumber: number): Promise<WeeklyReport> {
  const wk = (
    await getDb()
      .select()
      .from(weeks)
      .where(and(eq(weeks.year, year), eq(weeks.isoWeekNumber, weekNumber)))
      .limit(1)
  )[0];
  if (!wk) {
    return {
      week: null,
      sections: REPORT_TYPE_CODES.map((t) => ({ type: t, label: t === "RESERBA_II" ? "RESERBA II" : t, slots: [] })),
      summary: null,
      note: `Week ${weekNumber} of ${year} has not been started yet — no schedule exists for it.`,
    };
  }

  // Persisted assignments (source of truth)…
  const assigned = await baseRows().where(eq(assignments.weekId, wk.id));
  // …merged with the engine's read-only plan for UNASSIGNED reason codes.
  const { SchedulingService } = await import("./index");
  const plan = await SchedulingService.previewSchedule(wk.id).catch(() => null);

  const byKey = new Map(assigned.map((a) => [`${a.dakoId}|${a.assignmentType}`, a]));
  const slots = new Map<string, WeeklyReportSlot>();
  const seen = new Set<string>();
  for (const s of plan?.slots ?? []) {
    seen.add(`${s.dakoId}|${s.assignmentType}`);
    const hit = byKey.get(`${s.dakoId}|${s.assignmentType}`);
    slots.set(`${s.dakoId}|${s.assignmentType}`, {
      dakoId: s.dakoId,
      dakoName: s.dakoName,
      assignmentType: s.assignmentType,
      assignmentId: hit?.assignmentId ?? null,
      teacherName: hit ? hit.teacherName : (s.fullName ?? null),
      teacherCode: hit ? hit.teacherCode : (s.teacherCode ?? null),
      source: hit ? hit.assignmentSource : null,
      status: hit ? hit.status : null,
      reasonCode: hit ? null : (s.reasonCode ?? null),
      reason: hit ? null : (s.reason ?? null),
    });
  }
  // MANUAL/OVERRIDE/HISTORICAL rows whose slot the plan omits (preserved rows).
  for (const a of assigned) {
    const key = `${a.dakoId}|${a.assignmentType}`;
    if (!seen.has(key)) {
      slots.set(key, {
        dakoId: a.dakoId,
        dakoName: a.dakoName,
        assignmentType: a.assignmentType,
        assignmentId: a.assignmentId,
        teacherName: a.teacherName,
        teacherCode: a.teacherCode,
        source: a.assignmentSource,
        status: a.status,
        reasonCode: null,
        reason: null,
      });
    }
  }

  const order = new Map(REPORT_TYPE_CODES.map((t, i) => [t, i]));
  const all = [...slots.values()].sort(
    (a, b) =>
      a.dakoName.localeCompare(b.dakoName) ||
      (order.get(a.assignmentType as ReportTypeCode) ?? 9) - (order.get(b.assignmentType as ReportTypeCode) ?? 9),
  );
  const bySource: Record<string, number> = {};
  let assignedCount = 0;
  let unassigned = 0;
  for (const s of all) {
    if (s.teacherName && s.status === "ASSIGNED") {
      assignedCount += 1;
      bySource[s.source ?? "—"] = (bySource[s.source ?? "—"] ?? 0) + 1;
    } else {
      unassigned += 1;
    }
  }
  return {
    week: { id: wk.id, year: wk.year, weekNumber: wk.isoWeekNumber, startDate: wk.startDate, endDate: wk.endDate, status: wk.status },
    sections: REPORT_TYPE_CODES.map((t) => ({
      type: t,
      label: t === "RESERBA_II" ? "RESERBA II" : t,
      slots: all.filter((s) => s.assignmentType === t),
    })),
    summary: { assigned: assignedCount, unassigned, bySource },
    note: null,
  };
}

// ---------------------------------------------------------------------------
// C. Teacher assignment report
// ---------------------------------------------------------------------------

export interface TeacherAssignmentReport {
  teacher: { id: string; code: string; name: string; language: string; status: string } | null;
  filters: { year: number | null; dakoId: string | null; source: string | null; type: string | null };
  rows: ReportRow[];
}

export async function teacherAssignmentReport(opts: {
  teacherId?: string;
  year?: number;
  dakoId?: string;
  source?: string;
  type?: string;
  limit?: number;
}): Promise<TeacherAssignmentReport> {
  const conds = [];
  if (opts.teacherId) conds.push(eq(assignments.teacherId, opts.teacherId));
  if (opts.year) conds.push(eq(weeks.year, opts.year));
  if (opts.dakoId) conds.push(eq(assignments.dakoId, opts.dakoId));
  if (opts.source) conds.push(eq(assignments.assignmentSource, opts.source));
  if (opts.type) conds.push(eq(assignments.assignmentType, opts.type));

  const rows = await baseRows()
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(weeks.year), desc(weeks.isoWeekNumber), asc(dako.dakoCode))
    .limit(Math.min(1000, Math.max(1, opts.limit ?? 500)));

  let teacher: TeacherAssignmentReport["teacher"] = null;
  if (opts.teacherId) {
    const t = (await getDb().select().from(teachers).where(eq(teachers.id, opts.teacherId)).limit(1))[0];
    if (t) {
      teacher = {
        id: t.id,
        code: t.teacherCode,
        name: [t.firstName, t.middleName, t.lastName].filter(Boolean).join(" "),
        language: t.language,
        status: t.status,
      };
    }
  }
  return {
    teacher,
    filters: { year: opts.year ?? null, dakoId: opts.dakoId ?? null, source: opts.source ?? null, type: opts.type ?? null },
    rows: rows.map((r) => ({ ...r })),
  };
}

// ---------------------------------------------------------------------------
// D. Dako assignment report
// ---------------------------------------------------------------------------

export interface DakoAssignmentReport {
  dako: { id: string; code: string; name: string; language: string; status: string } | null;
  filters: { year: number | null; teacherId: string | null; source: string | null; type: string | null };
  rows: ReportRow[];
}

export async function dakoAssignmentReport(opts: {
  dakoId?: string;
  year?: number;
  teacherId?: string;
  source?: string;
  type?: string;
  limit?: number;
}): Promise<DakoAssignmentReport> {
  const conds = [];
  if (opts.dakoId) conds.push(eq(assignments.dakoId, opts.dakoId));
  if (opts.year) conds.push(eq(weeks.year, opts.year));
  if (opts.teacherId) conds.push(eq(assignments.teacherId, opts.teacherId));
  if (opts.source) conds.push(eq(assignments.assignmentSource, opts.source));
  if (opts.type) conds.push(eq(assignments.assignmentType, opts.type));

  const rows = await baseRows()
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(weeks.year), desc(weeks.isoWeekNumber), asc(dako.dakoCode))
    .limit(Math.min(1000, Math.max(1, opts.limit ?? 500)));

  let dakoInfo: DakoAssignmentReport["dako"] = null;
  if (opts.dakoId) {
    const d = (await getDb().select().from(dako).where(eq(dako.id, opts.dakoId)).limit(1))[0];
    if (d) {
      dakoInfo = { id: d.id, code: d.dakoCode, name: d.name, language: d.language, status: d.status };
    }
  }
  return {
    dako: dakoInfo,
    filters: { year: opts.year ?? null, teacherId: opts.teacherId ?? null, source: opts.source ?? null, type: opts.type ?? null },
    rows: rows.map((r) => ({ ...r })),
  };
}

// ---------------------------------------------------------------------------
// E. Source summary — AUTO / MANUAL / OVERRIDE / HISTORICAL cross-tab
// ---------------------------------------------------------------------------

export interface SourceSummaryReport {
  year: number | null;
  total: number;
  bySource: Record<string, number>;
  /** source × type cross-tab; types fixed to the three approved codes. */
  crossTab: Record<string, Record<string, number>>;
}

export async function sourceSummaryReport(year?: number): Promise<SourceSummaryReport> {
  const cols = {
    assignmentSource: assignments.assignmentSource,
    assignmentType: assignments.assignmentType,
    total: sql<number>`count(*)::int`,
  };
  const rows = await getDb()
    .select(cols)
    .from(assignments)
    .innerJoin(weeks, eq(weeks.id, assignments.weekId))
    .where(year ? eq(weeks.year, year) : undefined)
    .groupBy(assignments.assignmentSource, assignments.assignmentType);

  const bySource: Record<string, number> = {};
  const crossTab: Record<string, Record<string, number>> = {};
  let total = 0;
  for (const r of rows) {
    bySource[r.assignmentSource] = (bySource[r.assignmentSource] ?? 0) + r.total;
    const perType = (crossTab[r.assignmentSource] ??= {});
    perType[r.assignmentType] = r.total;
    total += r.total;
  }
  return { year: year ?? null, total, bySource, crossTab };
}
