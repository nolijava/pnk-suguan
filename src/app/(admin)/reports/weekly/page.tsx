import Link from "next/link";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { FilterForm } from "@/app/(admin)/_components";
import { weeklyReport } from "@/server/services/reports.service";
import { isoWeek, isoWeeksInYear } from "@/lib/iso-week";
import { StatusBadge, ReportSourceBadge } from "../_shared";
import { ReportPdfButton } from "../pdf-button";

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

      {/* Year/week apply as they change; "Current week" restores the default. */}
      <FilterForm
        action="/reports/weekly"
        values={{ year: String(year), week: String(week) }}
        resetLabel="Current week"
        resetHref={`/reports/weekly?year=${cur.year}&week=${cur.week}`}
        fields={[
          { kind: "number", name: "year", label: "Year", min: 1900, max: 2999, width: 90 },
          { kind: "number", name: "week", label: "ISO Week", min: 1, max: 53, width: 70 },
        ]}
      />

      {/* New Update #5 — print the selected ISO week. */}
      <div className="actions-row">
        <ReportPdfButton report="weekly" params={{ year, week }} label={`Generate PDF (W${String(week).padStart(2, "0")} ${year})`} />
      </div>

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
                        ) : s.reason ? (
                          <span className="info-note">{s.reason}</span>
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
