import Link from "next/link";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { celebrationsReport, countTeachersMissingCelebrationDates } from "@/server/services/celebration.service";
import { ReportPdfButton } from "../pdf-button";

export const dynamic = "force-dynamic";

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function mmddyyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/**
 * Update #1/#2 — Celebrations report: monthly birthday celebrant list and
 * grouped oath-anniversary notices. Read-only; birthdays/anniversaries sharing
 * a date are shown as ONE group. Derived ages/years only — never stored.
 */
export default async function CelebrationsReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("reports.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

  const now = new Date();
  const year = Number(flat.year ?? now.getUTCFullYear());
  const month = Number(flat.month ?? now.getUTCMonth() + 1);
  const invalid =
    !Number.isInteger(year) || year < 1900 || year > 2999 ||
    !Number.isInteger(month) || month < 1 || month > 12;

  if (invalid) {
    return (
      <>
        <div className="page-header"><div><h1>Celebrations</h1></div></div>
        <p>Invalid year/month selection.</p>
        <p><Link className="btn btn-secondary" href="/reports/celebrations">Back to current month</Link></p>
      </>
    );
  }

  const [report, missing] = await Promise.all([
    celebrationsReport(year, month, now),
    countTeachersMissingCelebrationDates(),
  ]);

  const ym = (delta: number) => {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  };
  const prev = ym(-1);
  const next = ym(1);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Celebrations — {MONTH_LABELS[month - 1]} {year}</h1>
          <p>Guro birthday celebrants and oath-taking (Panunumpa) anniversaries. Read-only.</p>
        </div>
      </div>

      <p>
        <Link className="btn btn-secondary" href={`/reports/celebrations?year=${prev.year}&month=${prev.month}`}>
          ← {MONTH_LABELS[prev.month - 1]} {prev.year}
        </Link>{" "}
        <Link className="btn btn-secondary" href={`/reports/celebrations?year=${next.year}&month=${next.month}`}>
          {MONTH_LABELS[next.month - 1]} {next.year} →
        </Link>{" "}
        <Link className="btn btn-secondary" href="/reports">Back to Reports</Link>
        {/* New Update #5 — print this month's celebrations. */}
        <ReportPdfButton
          report="celebrations"
          params={{ year, month }}
          label={`Generate PDF (${MONTH_LABELS[month - 1]} ${year})`}
        />
      </p>

      <section>
        <h2>Birthday celebrants — {MONTH_LABELS[month - 1]} {year}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Pangalan</th>
                <th scope="col">Code</th>
                <th scope="col">Birthday</th>
                <th scope="col">Turning</th>
              </tr>
            </thead>
            <tbody>
              {report.birthdayCelebrants.length === 0 ? (
                <tr><td colSpan={5}>No birthday celebrants this month.</td></tr>
              ) : (
                report.birthdayCelebrants.map((c) => (
                  <tr key={c.teacherId}>
                    <td>{c.day}</td>
                    <td>{c.teacherName}</td>
                    <td>{c.teacherCode}</td>
                    <td>{mmddyyyy(c.birthday)}</td>
                    <td>{c.turningAge}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Oath-taking (Panunumpa) anniversaries</h2>
        <p className="info-note">
          Teachers sharing the same anniversary date are grouped into one combined notice. Completed years are
          derived from the stored Panunumpa date, which is never modified.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Anniversary date</th>
                <th scope="col">Completed years</th>
                <th scope="col">Teachers</th>
              </tr>
            </thead>
            <tbody>
              {report.anniversaryGroups.length === 0 ? (
                <tr><td colSpan={3}>No oath-taking anniversaries this month.</td></tr>
              ) : (
                report.anniversaryGroups.map((g) => (
                  <tr key={g.date}>
                    <td>{mmddyyyy(g.date)}</td>
                    <td>{g.completedYearsLabel}</td>
                    <td>
                      {g.teachers.map((t) => (
                        <div key={t.teacherId}>
                          {t.teacherName} — {t.completedYears} year{t.completedYears === 1 ? "" : "s"}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {(missing.missingBirthday > 0 || missing.missingOath > 0) && (
        <p className="info-note">
          Completeness: {missing.missingBirthday} teacher(s) without a stored birthday,{" "}
          {missing.missingOath} without a Panunumpa date — they cannot appear in these notices.
        </p>
      )}
    </>
  );
}
