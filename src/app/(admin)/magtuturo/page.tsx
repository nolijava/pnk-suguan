import Link from "next/link";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { WeekService } from "@/server/services";
import { listMagtuturoForWeek, MAG_SEATS, type MagType } from "@/server/services/magtuturo.service";
import { isoWeek, isoWeeksInYear } from "@/lib/iso-week";
import { StatusBadge } from "../_components/status-badge";
import { StateCard } from "../_components/state-card";
import { hasPermission as hasPerm } from "@/server/auth/permissions";
import { MagtuturoActions, type MagRow } from "./magtuturo-actions";

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
  const rows = await listMagtuturoForWeek(week.id);

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

      <MagtuturoActions
        weekId={week.id}
        weekYear={week.year}
        weekNumber={week.isoWeekNumber}
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
        Duty rotation: eligible Katuwang (per Current Destination dako) take the seats first, rotating fairly within each
        dako and across dakos; remaining seats fall back to the general eligible pool.
      </p>
    </>
  );
}
