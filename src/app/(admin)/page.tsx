import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";
import { getDb } from "@/server/db/client";
import { weeks } from "@/server/db/schema";
import { buildAnnualSchedule } from "@/lib/annual";
import { isoWeek } from "@/lib/iso-week";
import { StatusBadge } from "./_components/status-badge";
import { AnnualTables } from "./annual-client";
import { GenerateSuguanButton } from "./generate-button";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("assignments.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

  const cur = isoWeek(new Date());
  const invalidYear =
    flat.year !== undefined &&
    (!/^\d{1,4}$/.test(flat.year) || Number(flat.year) < 1900 || Number(flat.year) > 2999);
  if (invalidYear) {
    return (
      <>
        <div className="page-header"><div><h1>PNK Suguan Dashboard</h1></div></div>
        <p className="error">Invalid year — must be an integer between 1900 and 2999.</p>
        <p><Link className="btn btn-secondary" href="/">Back to current year</Link></p>
      </>
    );
  }

  // The selected year drives ALL THREE annual tables (§4).
  const year = flat.year !== undefined ? Number(flat.year) : cur.year;
  const rows = await AssignmentService.listAssignmentsForYear(year);
  const schedule = buildAnnualSchedule(rows, year);
  // Phase 6 §6/§7/§13/§14 — persisted absence/modification provenance for cell
  // tooltips (batched; viewing stays read-only).
  const cellInfo = await AssignmentService.getAnnualCellInfo(year);

  // Current-week summary — real counts from persisted data; read-only view
  // never creates the week row (§20).
  const wk = (
    await getDb()
      .select()
      .from(weeks)
      .where(and(eq(weeks.year, cur.year), eq(weeks.isoWeekNumber, cur.week)))
      .limit(1)
  )[0];

  let summary: {
    status: string;
    sugo: number;
    reserba: number;
    reserbaIi: number;
    totalSlots: number;
  } | null = null;
  if (wk) {
    const weekAssignments = await AssignmentService.listAssignmentsForWeek(wk.id);
    const count = (t: string) =>
      weekAssignments.filter((a) => a.assignmentType === t && a.status === "ASSIGNED").length;
    const sugo = count("SUGO");
    const reserba = count("RESERBA");
    const reserbaIi = count("RESERBA_II");
    // Slot capacity: 3 slots per ACTIVE dako (disabled dakos get no new slots).
    const activeDakos = schedule.tables[0].dakoRows.filter((d) => !d.disabled).length;
    const fallbackDakos =
      activeDakos > 0 ? activeDakos : new Set(weekAssignments.map((a) => a.dakoId)).size;
    summary = {
      status: wk.status,
      sugo,
      reserba,
      reserbaIi,
      totalSlots: 3 * fallbackDakos,
    };
  }

  const canGenerate = user.roleCodes.includes("ADMIN") || user.roleCodes.includes("SCHEDULER");
  const currentWeekKey = schedule.year === cur.year ? `W${cur.week}` : null;

  // Phase 6 §27 — mutations are server-guarded; the writable flag only decides
  // whether cells are interactive in the UI (Server can clear/modify, Admin
  // additionally override). Every action still passes requirePermission + the
  // assertWeekMutable lifecycle gate server-side.
  const writable = canGenerate;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>PNK Suguan Dashboard</h1>
          <p>Annual Suguan schedule — SUGO, RESERBA, and RESERBA II for the selected year.</p>
        </div>
        {canGenerate ? (
          <div>
            {/* §16-§19 — new entry point into the EXISTING Phase 4 workflow. */}
            <GenerateSuguanButton currentYear={cur.year} currentWeek={cur.week} />
          </div>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="info-note" style={{ marginBottom: 12 }}>
          No schedule data yet for {year}. Assignments appear here after generation in the{" "}
          <Link href={`/schedule?year=${cur.year}&week=${cur.week}`}>Weekly Schedule</Link>.
        </div>
      ) : null}

      <AnnualTables
        schedule={schedule}
        currentWeekKey={currentWeekKey}
        currentIsoLabel={`W${cur.week} · ${cur.year}`}
        cellInfo={cellInfo}
        writable={writable}
      />

      {summary ? (
        <section className="dashboard-current-week">
          <h2>Current Week</h2>
          <p>
            <strong>
              ISO W{cur.week} · {wk!.startDate} – {wk!.endDate}
            </strong>{" "}
            <StatusBadge status={summary.status} />
          </p>
          <table className="summary-table">
            <tbody>
              <tr><th scope="row">SUGO</th><td>{summary.sugo} assigned</td></tr>
              <tr><th scope="row">RESERBA</th><td>{summary.reserba} assigned</td></tr>
              <tr><th scope="row">RESERBA II</th><td>{summary.reserbaIi} assigned</td></tr>
              <tr><th scope="row">Unassigned</th><td>{Math.max(summary.totalSlots - summary.sugo - summary.reserba - summary.reserbaIi, 0)}</td></tr>
            </tbody>
          </table>
          <p>
            <Link className="btn btn-primary" href={`/schedule?year=${cur.year}&week=${cur.week}`}>
              View Current Week
            </Link>
          </p>
        </section>
      ) : (
        <section className="dashboard-current-week">
          <h2>Current Week</h2>
          <p className="info-note">
            Week {cur.week} of {cur.year} has not been started yet.
            {canGenerate ? " Open the Weekly Schedule to encode availability and generate." : ""}
          </p>
          <p>
            <Link className="btn btn-primary" href={`/schedule?year=${cur.year}&week=${cur.week}`}>
              View Current Week
            </Link>
          </p>
        </section>
      )}

      <section className="dashboard-quick">
        <h2>Quick links</h2>
        <p>
          <Link className="btn btn-secondary" href="/teachers">Teachers</Link>{" "}
          <Link className="btn btn-secondary" href="/dako">Dako</Link>{" "}
          <Link className="btn btn-secondary" href="/availability">Availability</Link>{" "}
          <Link className="btn btn-secondary" href={`/schedule?year=${cur.year}&week=${cur.week}`}>Weekly Schedule</Link>
          {user.roleCodes.includes("ADMIN") ? (
            <>
              {" "}
              <Link className="btn btn-secondary" href="/audit-logs">Audit</Link>
            </>
          ) : null}
        </p>
      </section>
    </>
  );
}
