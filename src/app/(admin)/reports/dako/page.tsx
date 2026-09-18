import Link from "next/link";
import { requirePermission } from "@/server/auth/guard";
import { dakoAssignmentReport, REPORT_SOURCE_CODES, REPORT_TYPE_CODES } from "@/server/services/reports.service";
import { DakoService } from "@/server/services";
import { isoWeek } from "@/lib/iso-week";
import { StatusBadge, ReportSourceBadge, fmtUtc } from "../_shared";

export const dynamic = "force-dynamic";

/** Phase 8 — dako assignment history report (Part G). Read-only. */
export default async function DakoReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("reports.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => (Array.isArray(v) ? [k, v[0]] : [k, v])));
  const cur = isoWeek(new Date());

  const year = flat.year ? Number(flat.year) : undefined;
  const invalidYear = flat.year !== undefined && (!Number.isInteger(year) || year! < 1900 || year! > 2999);
  const dakoId = typeof flat.dakoId === "string" && flat.dakoId.trim() ? flat.dakoId : undefined;
  const source = REPORT_SOURCE_CODES.includes(flat.source as (typeof REPORT_SOURCE_CODES)[number]) ? flat.source : undefined;
  const type = REPORT_TYPE_CODES.includes(flat.type as (typeof REPORT_TYPE_CODES)[number]) ? flat.type : undefined;

  const { rows: allDakos } = await DakoService.listDako({ pageSize: 100, sort: "code", order: "asc" });
  const report = invalidYear ? null : await dakoAssignmentReport({ dakoId, year, source, type });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dako assignment history</h1>
          {report?.dako ? (
            <p>
              <strong>{report.dako.name}</strong> <span className="info-note">({report.dako.code})</span> ·{" "}
              {report.dako.language} · <StatusBadge status={report.dako.status} /> · {report.rows.length} assignment
              row(s)
            </p>
          ) : (
            <p>Select a dako to view its assignment history across years.</p>
          )}
        </div>
      </div>

      <form method="get" action="/reports/dako" className="week-jump">
        <label>
          Dako{" "}
          <select name="dakoId" defaultValue={dakoId ?? ""}>
            <option value="">— all dakos —</option>
            {allDakos.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label>
          Year{" "}
          <select name="year" defaultValue={year ?? ""}>
            <option value="">— all —</option>
            {[0, 1, 2].map((i) => (
              <option key={cur.year - i} value={cur.year - i}>
                {cur.year - i}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source{" "}
          <select name="source" defaultValue={source ?? ""}>
            <option value="">— all —</option>
            {REPORT_SOURCE_CODES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Type{" "}
          <select name="type" defaultValue={type ?? ""}>
            <option value="">— all —</option>
            {REPORT_TYPE_CODES.map((t) => (
              <option key={t} value={t}>{t === "RESERBA_II" ? "RESERBA II" : t}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-secondary">Go</button>
        <Link className="btn btn-secondary" href="/reports/dako">Reset</Link>
      </form>

      {invalidYear ? <p className="error">Invalid year — must be an integer between 1900 and 2999.</p> : null}

      {report ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Week / Year</th>
                <th scope="col">Teacher</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Source</th>
                <th scope="col">Assigned at</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 ? (
                <tr><td colSpan={6}>No assignments match the selected filters.</td></tr>
              ) : (
                report.rows.map((r) => (
                  <tr key={r.assignmentId}>
                    <td>W{String(r.weekNumber).padStart(2, "0")} · {r.year}</td>
                    <td>{r.teacherName}</td>
                    <td>{r.assignmentType === "RESERBA_II" ? "RESERBA II" : r.assignmentType}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td><ReportSourceBadge source={r.assignmentSource} /></td>
                    <td className="info-note">{fmtUtc(r.assignedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="info-note">
        Read-only report. Assignment rows never modify Current Destination or Destination History.
      </p>
    </>
  );
}
