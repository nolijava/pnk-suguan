import Link from "next/link";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { SchedulingService, WeekService } from "@/server/services";
import { isoWeek, isoWeeksInYear } from "@/lib/iso-week";
import { StatusBadge } from "../_components/status-badge";
import { StateCard } from "../_components/state-card";
import { hasPermission as hasPerm } from "@/server/auth/permissions";
import { ScheduleActions, type SlotRow } from "./schedule-actions";
import { formatFullName } from "@/lib/name";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  SUGO: "SUGO",
  RESERBA: "RESERBA",
  RESERBA_II: "RESERBA II",
};

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("assignments.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const notice = typeof sp.notice === "string" ? sp.notice : undefined;
  const error = typeof sp.error === "string" ? sp.error : undefined;

  // Week selection mirrors /availability: explicit year/week, else current ISO week.
  const cur = isoWeek(new Date());
  const year = Number(flat.year ?? cur.year);
  const weekNum = Number(flat.week ?? cur.week);
  const invalid =
    !Number.isInteger(year) || !Number.isInteger(weekNum) ||
    year < 1900 || year > 2999 || weekNum < 1 || weekNum > isoWeeksInYear(year);
  if (invalid) {
    return (
      <>
        <div className="page-header"><div><h1>Weekly Schedule</h1></div></div>
        <StateCard
          kind="error"
          message={`Invalid week selection${Number.isInteger(year) && year >= 1900 && year <= 2999 ? ` — year ${year} has ${isoWeeksInYear(year)} ISO weeks` : " (year must be 1900–2999)"}.`}
        />
        <p><Link className="btn btn-secondary" href="/schedule">Back to current week</Link></p>
      </>
    );
  }

  const week = await WeekService.resolveWeek({ year, week: weekNum });
  const [absenceCount, assignments, plan] = await Promise.all([
    SchedulingService.countPreviousWeekAbsences(week.id),
    listAssignments(week.id),
    SchedulingService.previewSchedule(week.id).catch(() => null),
  ]);

  const canWrite = hasPerm(user.roleCodes, "assignments.write");
  const canGenerate = hasPerm(user.roleCodes, "scheduling.generate");
  const canFinalize = hasPerm(user.roleCodes, "weeks.finalize");
  // Phase 7 — same permission gates the PDF endpoint server-side.
  const canPdf = canWrite;
  const canPublish = hasPerm(user.roleCodes, "weeks.publish");
  // §24 — the PUBLISHED emergency unlock is a SUPER_ADMIN-only entry point;
  // the endpoint re-checks the role and the secret server-side.
  const isSuperAdmin = user.roleCodes.includes("SUPER_ADMIN");
  // Group 4 — FINALIZED revision uses the existing authorized correction
  // workflow (weeks.unlock: ADMIN, SUPER_ADMIN and SCHEDULER/ENCODER).
  // VIEWER does not hold it, and the endpoint re-checks server-side either way.
  const canRevise = hasPerm(user.roleCodes, "weeks.unlock");

  // Week navigation via ISO arithmetic (same as availability page).
  const prevStart = new Date(`${week.startDate}T00:00:00Z`);
  prevStart.setUTCDate(prevStart.getUTCDate() - 7);
  const nextStart = new Date(`${week.startDate}T00:00:00Z`);
  nextStart.setUTCDate(nextStart.getUTCDate() + 7);
  const prev = isoWeek(prevStart);
  const next = isoWeek(nextStart);

  // Merge DB rows (what is actually assigned) with the engine plan (what would be).
  // Dedupe at SLOT level (dako × type): the plan omits slots occupied by
  // MANUAL/OVERRIDE rows (regeneration preserves them), so those rows must
  // still appear — a dako-level "covered" check would drop them entirely.
  const rows: SlotRow[] = [];
  const byKey = new Map(assignments.map((a) => [`${a.dakoId}|${a.assignmentType}`, a]));
  const seenSlots = new Set<string>();
  for (const s of plan?.slots ?? []) {
    seenSlots.add(`${s.dakoId}|${s.assignmentType}`);
    const existing = byKey.get(`${s.dakoId}|${s.assignmentType}`);
    rows.push({
      id: existing?.id ?? null,
      dakoId: s.dakoId,
      dakoName: s.dakoName,
      dakoCode: s.dakoCode,
      assignmentType: s.assignmentType,
      // Plan suggestions must never render as assignments: without a DB row
      // the teacher columns stay empty (UNASSIGNED) and the engine's proposal
      // is surfaced in the reason column as an explicit PLANNED note.
      teacherName: existing ? assignmentTeacherName(assignments, existing) : null,
      teacherCode: existing ? existing.teacherCode : null,
      source: existing ? existing.assignmentSource : null,
      status: existing ? existing.status : null,
      reasonCode: existing ? null : s.reasonCode,
      reason: existing
        ? null
        : s.reason ??
          (s.fullName
            ? `PLANNED — engine suggests ${s.fullName}${s.teacherCode ? ` (${s.teacherCode})` : ""} on regeneration; not assigned yet`
            : null),
      occupiedByManual: existing ? existing.assignmentSource !== "AUTO" : false,
    });
  }
  // Assignment rows whose slot the plan doesn't include: MANUAL/OVERRIDE
  // (plan omits their slots) and any rows on dakos the plan doesn't cover
  // (e.g. disabled dako slots).
  for (const a of assignments) {
    if (!seenSlots.has(`${a.dakoId}|${a.assignmentType}`)) {
      rows.push({
        id: a.id,
        dakoId: a.dakoId,
        dakoName: a.dakoName,
        dakoCode: a.dakoCode,
        assignmentType: a.assignmentType,
        teacherName: assignmentTeacherName(assignments, a),
        teacherCode: a.teacherCode,
        source: a.assignmentSource,
        status: a.status,
        reasonCode: null,
        reason: null,
        occupiedByManual: a.assignmentSource !== "AUTO",
      });
    }
  }
  rows.sort((x, y) =>
    x.dakoCode.localeCompare(y.dakoCode) ||
    ["SUGO", "RESERBA", "RESERBA_II"].indexOf(x.assignmentType) -
      ["SUGO", "RESERBA", "RESERBA_II"].indexOf(y.assignmentType),
  );

  const summary = plan?.summary ?? null;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Weekly Schedule</h1>
          <p>Automatic Suguan generation, review, and manual overrides. DRAFT weeks only for generation.</p>
        </div>
      </div>

      <div className="week-nav">
        <Link className="btn btn-secondary" href={`/schedule?year=${prev.year}&week=${prev.week}`}>‹ Week {prev.week}</Link>
        <div className="week-title">
          <strong>Week {week.isoWeekNumber} · {week.year}</strong>
          <span className="info-note">{week.startDate} → {week.endDate} · </span>
          <StatusBadge status={week.status} />
        </div>
        <Link className="btn btn-secondary" href={`/schedule?year=${next.year}&week=${next.week}`}>Week {next.week} ›</Link>
        {week.year !== cur.year || week.isoWeekNumber !== cur.week ? (
          <Link className="btn btn-secondary" href={`/schedule?year=${cur.year}&week=${cur.week}`}>Current week</Link>
        ) : null}
        <form method="get" action="/schedule" className="week-jump">
          <label>Year <input type="number" name="year" defaultValue={week.year} min={1900} max={2999} style={{ width: 90 }} /></label>
          <label>ISO Week <input type="number" name="week" defaultValue={week.isoWeekNumber} min={1} max={53} style={{ width: 70 }} /></label>
          <button type="submit" className="btn btn-secondary">Go</button>
        </form>
      </div>

      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <ScheduleActions
        weekId={week.id}
        weekYear={week.year}
        weekNumber={week.isoWeekNumber}
        weekStatus={week.status as "DRAFT" | "FINALIZED" | "PUBLISHED"}
        canWrite={canWrite}
        canGenerate={canGenerate}
        canFinalize={canFinalize}
        canPublish={canPublish}
        canPdf={canPdf}
        isSuperAdmin={isSuperAdmin}
        canRevise={canRevise}
        currentUserId={user.userId}
        absenceCount={absenceCount.count}
        rows={rows}
        summary={summary}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function listAssignments(weekId: string) {
  const { getDb } = await import("@/server/db/client");
  const { assignments, dako, teachers } = await import("@/server/db/schema");
  const { eq } = await import("drizzle-orm");
  const db = getDb();
  const rows = await db
    .select({
      id: assignments.id,
      dakoId: assignments.dakoId,
      dakoName: dako.name,
      dakoCode: dako.dakoCode,
      assignmentType: assignments.assignmentType,
      assignmentSource: assignments.assignmentSource,
      status: assignments.status,
      teacherId: assignments.teacherId,
      teacherCode: teachers.teacherCode,
      firstName: teachers.firstName,
      middleName: teachers.middleName,
      lastName: teachers.lastName,
      suffix: teachers.suffix,
    })
    .from(assignments)
    .innerJoin(dako, eq(dako.id, assignments.dakoId))
    .innerJoin(teachers, eq(teachers.id, assignments.teacherId))
    .where(eq(assignments.weekId, weekId))
    .orderBy(dako.dakoCode, assignments.assignmentType);
  return rows;
}

type AssignmentRow = Awaited<ReturnType<typeof listAssignments>>[number];

function assignmentTeacherName(
  rows: AssignmentRow[],
  a: Pick<AssignmentRow, "firstName" | "middleName" | "lastName" | "suffix">,
): string {
  return formatFullName(a);
}
