import Link from "next/link";
import { requirePermission } from "@/server/auth/guard";
import { weeklyReport } from "@/server/services/reports.service";
import { isoWeek, isoWeeksInYear } from "@/lib/iso-week";
import { StatusBadge, ReportSourceBadge } from "../_shared";

export const dynamic = "force-dynamic";

/** Phase 8 — weekly report (Part F.4): A. SUGO / B. RESERBA / C. RESERBA II. */
export default async function WeeklyReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("reports.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => (Array.isArray(v) ? [k, v[0]] : [k, v])));
  const cur = isoWeek(new Date());

  const year = Number(flat.year ?? cur.year);
  const week = Number(flat.week ?? cur.week);
  const valid = Number.isInteger(year) && year >= 1900 && year <= 2999 && Number.isInteger(week) && week >= 1 && week <= isoWeeksInYear(year);
  if (!valid) {
    return (
      <>
        <div className="page-header"><div><h1>Weekly report</h1></div></div>
        <p className="error">Invalid week selection.</p>
        <p><Link className="btn btn-secondary" href="/reports/weekly">Back to current week</Link></p>
      </>
    );
  }

  const report = await weeklyReport(year, week);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>
            Weekly report — W{String(week).padStart(2, "0")} · {year}
          </h1>
          {report.week ? (
            <p>
              {report.week.startDate} → {report.week.endDate} · <StatusBadge status={report.week.status} /> ·{" "}
              {report.summary!.assigned} assigned · {report.summary!.unassigned} unassigned
              {report.summary ? " · " + Object.entries(report.summary.bySource).map(([s, n]) => `${s} ${n}`).join(" · ") : ""}
            </p>
          ) : (
            <p className="info-note">{report.note}</p>
          )}
        </div>
      </div>

      <form method="get" action="/reports/weekly" className="week-jump">
        <label>
          Year <input type="number" name="year" defaultValue={year} min={1900} max={2999} style={{ width: 90 }} />
        </label>
        <label>
          ISO Week <input type="number" name="week" defaultValue={week} min={1} max={53} style={{ width: 70 }} />
        </label>
        <button type="submit" className="btn btn-secondary">Go</button>
        <Link className="btn btn-secondary" href={`/reports/weekly?year=${cur.year}&week=${cur.week}`}>Current week</Link>
      </form>

      {report.sections.map((sec) => (
        <section key={sec.type} className="sched-section">
          <h2>{sec.label}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Dako</th>
                  <th scope="col">Teacher</th>
                  <th scope="col">Status</th>
                  <th scope="col">Source</th>
                  <th scope="col">Unassigned reason</th>
                </tr>
              </thead>
              <tbody>
                {sec.slots.length === 0 ? (
                  <tr><td colSpan={5}>No {sec.label} slots recorded for this week.</td></tr>
                ) : (
                  sec.slots.map((s, i) => (
                    <tr key={`${s.dakoId}|${s.assignmentType}|${i}`}>
                      <td>{s.dakoName}</td>
                      <td>{s.teacherName ?? <span className="info-note">—</span>}</td>
                      <td>{s.status ? <StatusBadge status={s.status} /> : <span className="info-note">—</span>}</td>
                      <td>{s.source ? <ReportSourceBadge source={s.source} /> : <span className="info-note">—</span>}</td>
                      <td>
                        {s.reasonCode ? (
                          <span className="info-note">
                            {s.reasonCode}
                            {s.reason ? `: ${s.reason}` : ""}
                          </span>
                        ) : (
                          <span className="info-note">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <p className="info-note">
        Read-only report. Unassigned reason codes come from the scheduling engine&apos;s read-only preview — no report
        operation assigns, clears, or mutates anything.
      </p>
    </>
  );
}
