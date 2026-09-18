import Link from "next/link";
import { requirePermission } from "@/server/auth/guard";
import { ReportsService } from "@/server/services";
import { isoWeek } from "@/lib/iso-week";
import { REPORT_SOURCE_CODES } from "@/server/services/reports.service";

export const dynamic = "force-dynamic";

/** Phase 8 — reports index (Part F). Read-only; RBAC via reports.read. */
export default async function ReportsIndexPage() {
  await requirePermission("reports.read");
  const cur = isoWeek(new Date());

  const summary = await ReportsService.sourceSummaryReport(cur.year);
  const sources = [...REPORT_SOURCE_CODES, ...Object.keys(summary.bySource).filter((s) => !REPORT_SOURCE_CODES.includes(s as (typeof REPORT_SOURCE_CODES)[number]))];

  const yearLinks = [cur.year - 1, cur.year, cur.year + 1];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p>Read-only operational reporting over real schedule data. No report modifies scheduling data.</p>
        </div>
      </div>

      <section className="dashboard-quick">
        <h2>Available reports</h2>
        <p>
          {(["SUGO", "RESERBA", "RESERBA_II"] as const).map((t) => (
            <span key={t}>
              <Link className="btn btn-secondary" href={`/reports/annual?year=${cur.year}&type=${t}`}>
                {t === "RESERBA_II" ? "Annual RESERBA II" : `Annual ${t}`} {cur.year}
              </Link>{" "}
            </span>
          ))}
          <Link className="btn btn-secondary" href={`/reports/weekly?year=${cur.year}&week=${cur.week}`}>
            Weekly report (W{String(cur.week).padStart(2, "0")})
          </Link>{" "}
          <Link className="btn btn-secondary" href="/reports/teacher">Teacher assignment history</Link>{" "}
          <Link className="btn btn-secondary" href="/reports/dako">Dako assignment history</Link>
        </p>
        <p className="info-note">
          Annual and weekly links open the current ISO year/week; use each report&apos;s year/week selectors to change.
        </p>
      </section>

      <section>
        <h2>Assignment source summary — {cur.year}</h2>
        <p className="info-note">
          Counts of assignment rows by source (AUTO / MANUAL / OVERRIDE / HISTORICAL) × Suguan type. Historical
          assignments keep their HISTORICAL source in every report.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">SUGO</th>
                <th scope="col">RESERBA</th>
                <th scope="col">RESERBA II</th>
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {sources.length === 0 ? (
                <tr><td colSpan={5}>No assignments recorded for {cur.year}.</td></tr>
              ) : (
                sources.map((s) => (
                  <tr key={s}>
                    <td><span className={s === "HISTORICAL" ? "badge badge-historical" : "badge badge-gray"}>{s}</span></td>
                    <td>{summary.crossTab[s]?.SUGO ?? 0}</td>
                    <td>{summary.crossTab[s]?.RESERBA ?? 0}</td>
                    <td>{summary.crossTab[s]?.RESERBA_II ?? 0}</td>
                    <td>{summary.bySource[s] ?? 0}</td>
                  </tr>
                ))
              )}
              {sources.length > 0 ? (
                <tr>
                  <th scope="row">All sources</th>
                  <td>{sources.reduce((a, s) => a + (summary.crossTab[s]?.SUGO ?? 0), 0)}</td>
                  <td>{sources.reduce((a, s) => a + (summary.crossTab[s]?.RESERBA ?? 0), 0)}</td>
                  <td>{sources.reduce((a, s) => a + (summary.crossTab[s]?.RESERBA_II ?? 0), 0)}</td>
                  <td>{summary.total}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="info-note">Other years: {yearLinks.map((y) => ` ${y}`)}. Change the year inside each report view.</p>
      </section>
    </>
  );
}
