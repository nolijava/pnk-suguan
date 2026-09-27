import Link from "next/link";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { WeekService } from "@/server/services";
import { listMagtuturoForWeek, listMagtuturoForYear, MAG_SEATS, type MagType } from "@/server/services/magtuturo.service";
import { buildMagtuturoHistory } from "@/lib/magtuturo-history";
import { isoWeek, isoWeeksInYear } from "@/lib/iso-week";
import { StatusBadge } from "../_components/status-badge";
import { StateCard } from "../_components/state-card";
import { hasPermission as hasPerm } from "@/server/auth/permissions";
import { MagtuturoActions, type MagRow } from "./magtuturo-actions";
import { MagtuturoHistoryScroll } from "./magtuturo-history-scroll";

export const dynamic = "force-dynamic";

/** 21.12 — assigned-date fields use the MM/DD/YYYY service date. */
function mmddyyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

export default async function MagtuturoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("assignments.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

  const cur = isoWeek(new Date());
  const year = Number(flat.year ?? cur.year);
  const weekNum = Number(flat.week ?? cur.week);
  const invalid =
    !Number.isInteger(year) || !Number.isInteger(weekNum) ||
    year < 1900 || year > 2999 || weekNum < 1 || weekNum > isoWeeksInYear(year);
  if (invalid) {
    return (
      <>
        <div className="page-header"><div><h1>Mga Magtuturo sa Klase</h1></div></div>
        <StateCard
          kind="error"
          message={`Invalid week selection${Number.isInteger(year) && year >= 1900 && year <= 2999 ? ` — year ${year} has ${isoWeeksInYear(year)} ISO weeks` : " (year must be 1900–2999)"}.`}
        />
        <p><Link className="btn btn-secondary" href="/magtuturo">Back to current week</Link></p>
      </>
    );
  }

  const week = await WeekService.resolveWeek({ year, week: weekNum });
  const [rows, annualRows] = await Promise.all([
    listMagtuturoForWeek(week.id),
    listMagtuturoForYear(year),
  ]);
  const history = buildMagtuturoHistory(annualRows, year);
  const previousMonday = new Date(`${week.startDate}T00:00:00Z`);
  previousMonday.setUTCDate(previousMonday.getUTCDate() - 7);
  const nextMonday = new Date(`${week.startDate}T00:00:00Z`);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
  const previousWeek = isoWeek(previousMonday);
  const nextWeek = isoWeek(nextMonday);
  const currentIsSelected = year === cur.year && weekNum === cur.week;

  const canWrite = hasPerm(user.roleCodes, "assignments.write");
  const canGenerate = hasPerm(user.roleCodes, "scheduling.generate");

  const byType: Record<MagType, (MagRow | null)[]> = { SUGO: [], RESERBA: [] };
  for (const t of ["SUGO", "RESERBA"] as const) {
    for (let seat = 1; seat <= MAG_SEATS[t]; seat++) {
      byType[t].push((rows.find((r) => r.magType === t && r.seat === seat) as MagRow | undefined) ?? null);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Mga Magtuturo sa Klase</h1>
          <p className="subtitle">
            Week {week.isoWeekNumber} · {week.year} — <StatusBadge status={week.status} />
          </p>
        </div>
      </div>

      <div className="week-nav" aria-label="Weekly Selection">
        <Link className="btn btn-secondary" href={`/magtuturo?year=${previousWeek.year}&week=${previousWeek.week}`}>
          ‹ Week {previousWeek.week}
        </Link>
        <div className="week-title">
          <strong>Weekly Selection</strong>
          <span className="info-note">ISO Week {week.isoWeekNumber} · {week.year}</span>
        </div>
        <Link className="btn btn-secondary" href={`/magtuturo?year=${nextWeek.year}&week=${nextWeek.week}`}>
          Week {nextWeek.week} ›
        </Link>
        {!currentIsSelected ? (
          <Link className="btn btn-secondary" href={`/magtuturo?year=${cur.year}&week=${cur.week}`}>
            Current week
          </Link>
        ) : null}
        <form method="get" action="/magtuturo" className="week-jump">
          <label>
            Year
            <input type="number" name="year" defaultValue={week.year} min={1900} max={2999} style={{ width: 90 }} />
          </label>
          <label>
            ISO Week
            <input type="number" name="week" defaultValue={week.isoWeekNumber} min={1} max={53} style={{ width: 70 }} />
          </label>
          <button type="submit" className="btn btn-secondary">Go</button>
        </form>
      </div>

      <MagtuturoActions
        weekId={week.id}
        weekYear={week.year}
        weekNumber={week.isoWeekNumber}
        monthYear={Number(week.endDate.slice(0, 4))}
        weekStatus={week.status as "DRAFT" | "FINALIZED" | "PUBLISHED"}
        serviceDate={mmddyyyy(week.endDate)}
        canWrite={canWrite}
        canGenerate={canGenerate}
        sugo={byType.SUGO}
        reserba={byType.RESERBA}
      />

      <p className="info-note">
        4 SUGO + 2 RESERBA per week. ABSENT teachers remain eligible for this category (continuity rules apply);
        Master INACTIVE, weekly INACTIVE, English-Dako assignment and oath-date rules are enforced by the server.
        Magtuturo rotation is duty-neutral: it follows only its own Magtuturo assignment history — Destinado or
        Katuwang status and Current Destination do not affect priority. Ordinary seats go to the lowest Magtuturo
        assignment count, then the older last Magtuturo assignment, with the teacher ID as the deterministic final
        tie-break; SUGO + ABSENT continuity and non-ABSENT RESERBA promotion still outrank this rotation.
      </p>

      <section className="annual-section magtuturo-history" aria-label={`Magtuturo weekly history ${history.year}`}>
        <h2>Magtuturo Weekly History — {history.year}</h2>
        <p className="annual-subject">One Magtuturo table · {history.weekNumbers.length} ISO weeks · selected ISO year {history.year}</p>
        <div className="annual-scroll" tabIndex={0} role="region" aria-label={`Magtuturo weekly history table ${history.year}`}>
          <table className="annual-table">
            <thead>
              <tr>
                <th scope="col" className="dako-col">GAMPANIN</th>
                {history.weekNumbers.map((n) => <th scope="col" key={n}>Week {n}</th>)}
              </tr>
            </thead>
            <tbody>
              {history.rows.map((row) => (
                <tr key={`${row.magType}-${row.seat}`}>
                  <th scope="row" className="dako-col dako-row-head">{row.label}</th>
                  {row.cells.map((teacherName, index) => {
                    const weekNumber = history.weekNumbers[index]!;
                    return (
                      <td key={weekNumber} aria-label={teacherName ?? `${row.label}, Week ${weekNumber}: unassigned`}>
                        {teacherName ?? <span className="muted">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <MagtuturoHistoryScroll
          key={history.year}
          historyYear={history.year}
          currentIsoYear={cur.year}
          currentIsoWeek={cur.week}
          weekCount={history.weekNumbers.length}
        />
      </section>
    </>
  );
}
