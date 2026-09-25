import Link from "next/link";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { FilterForm } from "@/app/(admin)/_components";
import { annualTypeReport, type ReportTypeCode } from "@/server/services/reports.service";
import { isoWeek } from "@/lib/iso-week";
import { StatusBadge, ReportSourceBadge, fmtUtc } from "../_shared";
import { ReportPdfButton } from "../pdf-button";

export const dynamic = "force-dynamic";

const VALID_TYPES: ReportTypeCode[] = ["SUGO", "RESERBA", "RESERBA_II"];

/** Phase 8 — annual per-type report (Part F.1–3): real rows, summary, filters. */
export default async function AnnualReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("reports.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => (Array.isArray(v) ? [k, v[0]] : [k, v])));
  const cur = isoWeek(new Date());

  const year = Number(flat.year ?? cur.year);
  const typeParam = (flat.type ?? "SUGO").toUpperCase();
  const type: ReportTypeCode = VALID_TYPES.includes(typeParam as ReportTypeCode) ? (typeParam as ReportTypeCode) : "SUGO";
  const invalid = !Number.isInteger(year) || year < 1900 || year > 2999;
  if (invalid) {
    return (
      <>
        <div className="page-header"><div><h1>Annual {type} report</h1></div></div>
        <p className="error">Invalid year — must be an integer between 1900 and 2999.</p>
        <p><Link className="btn btn-secondary" href={`/reports/annual?type=${type}`}>Back</Link></p>
      </>
    );
  }

  const report = await annualTypeReport(year, type);
  const label = type === "RESERBA_II" ? "RESERBA II" : type;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Annual {label} report — {report.year}</h1>
          <p>
            {report.summary.totalAssigned} assigned across {report.summary.dakosCovered} dako(s) and{" "}
            {report.summary.weeksCovered} of {report.isoWeeks} ISO weeks.{" "}
            {Object.entries(report.summary.bySource).map(([s, n]) => `${s} ${n}`).join(" · ") || "no assignments yet"}
          </p>
        </div>
      </div>

      {/* Auto-applying filters (no Apply/Go). Reset = the current year. */}
      <FilterForm
        action="/reports/annual"
        values={{ year: String(report.year), type }}
        resetLabel="Current year"
        resetHref={`/reports/annual?year=${cur.year}&type=${type}`}
        fields={[
          { kind: "number", name: "year", label: "Year", min: 1900, max: 2999, width: 90 },
          {
            name: "type",
            label: "Type",
            options: [
              { value: "SUGO", label: "SUGO" },
              { value: "RESERBA", label: "RESERBA" },
              { value: "RESERBA_II", label: "RESERBA II" },
            ],
          },
        ]}
      />

      {/* New Update #5 — print the SAME selection the page is showing. */}
      <div className="actions-row">
        <ReportPdfButton report="annual" params={{ year: report.year, type }} label={`Generate PDF (Annual ${label})`} />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Dako</th>
              <th scope="col">Week</th>
              <th scope="col">Teacher</th>
              <th scope="col">Status</th>
              <th scope="col">Source</th>
              <th scope="col">Assigned at</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 ? (
              <tr><td colSpan={6}>No {label} assignments recorded for {report.year}.</td></tr>
            ) : (
              report.rows.map((r) => (
                <tr key={r.assignmentId}>
                  <td>{r.dakoName}</td>
                  <td>W{String(r.weekNumber).padStart(2, "0")}</td>
                  <td>{r.teacherName}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td><ReportSourceBadge source={r.assignmentSource} /></td>
                  <td className="info-note">{fmtUtc(r.assignedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="info-note">
        Read-only report. Teacher codes are internal reporting identifiers and are not shown here; the physical Weekly
        Suguan PDF remains the approved print output.
      </p>
    </>
  );
}
