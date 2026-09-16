import Link from "next/link";
import { requirePermission } from "@/server/auth/guard";
import { AvailabilityService, WeekService, DakoService } from "@/server/services";
import { isoWeek, isoWeeksInYear } from "@/lib/iso-week";
import { availabilityQuerySchema } from "@/lib/validation/query-schemas";
import { StatusBadge } from "../_components/status-badge";
import { AvailabilityEditor, type EditorRow } from "../_components/availability-editor";
import { hasPermission } from "@/server/auth/permissions";
import { StateCard } from "../_components/state-card";

export const dynamic = "force-dynamic";

const AVAILABILITY_FILTERS = [
  { value: "AVAILABLE", label: "AVAILABLE" },
  { value: "ABSENT", label: "ABSENT" },
  { value: "INACTIVE_WEEKLY", label: "INACTIVE (weekly)" },
  { value: "INACTIVE_MASTER", label: "INACTIVE (master)" },
  { value: "NOT_ENCODED", label: "NOT ENCODED (no record)" },
];

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("availability.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const notice = typeof sp.notice === "string" ? sp.notice : undefined;
  const error = typeof sp.error === "string" ? sp.error : undefined;

  // Week selection (§8/§9): explicit weekId, else year+week, else current ISO week.
  // Invalid manual year/week input renders a friendly error state (no crash).
  const cur = isoWeek(new Date());
  const year = Number(flat.year ?? cur.year);
  const weekNum = Number(flat.week ?? cur.week);
  const weekInputInvalid =
    flat.weekId === undefined &&
    (!Number.isInteger(year) || !Number.isInteger(weekNum) ||
      year < 1900 || year > 2999 || weekNum < 1 || weekNum > isoWeeksInYear(year));
  if (weekInputInvalid) {
    return (
      <>
        <div className="page-header">
          <div>
            <h1>Weekly Availability</h1>
          </div>
        </div>
        <StateCard
          kind="error"
          message={`Invalid week selection${Number.isInteger(year) && year >= 1900 && year <= 2999 ? ` — year ${year} has ${isoWeeksInYear(year)} ISO weeks` : " (year must be 1900–2999)"}.`
        }
        />
        <p>
          <Link className="btn btn-secondary" href="/availability">Back to current week</Link>
        </p>
      </>
    );
  }
  const week =
    flat.weekId && typeof flat.weekId === "string" && flat.weekId.length > 0
      ? await WeekService.resolveWeek({ weekId: flat.weekId })
      : await WeekService.resolveWeek({ year, week: weekNum });

  // Filters — parsed with the strict schema; purokGrupo is intentionally absent.
  const parsed = availabilityQuerySchema.safeParse({ ...flat, weekId: week.id });
  const q = parsed.success
    ? parsed.data
    : ({ weekId: week.id } as import("@/lib/validation/query-schemas").AvailabilityQuery);

  const [list, correctionActive, correctionHolder, fillBlankCount, dakoList] = await Promise.all([
    AvailabilityService.listWeeklyAvailability(week.id, {
      search: q.q,
      availability: q.availability,
      masterStatus: q.masterStatus,
      language: q.language,
      currentDestinationId: q.currentDestinationId,
      sort: q.sort,
      order: q.order,
    }),
    AvailabilityService.isAvailabilityCorrectionActive(week.id),
    AvailabilityService.correctionGrantHolder(week.id),
    AvailabilityService.countFillBlankTargets(week.id),
    DakoService.listDako({ pageSize: 100 }),
  ]);

  const canWrite = hasPermission(user.roleCodes, "availability.write");
  const isAdmin = user.roleCodes.includes("ADMIN");

  // Week navigation links via ISO arithmetic — no weeks created just by rendering nav.
  const prevStart = new Date(`${week.startDate}T00:00:00Z`);
  prevStart.setUTCDate(prevStart.getUTCDate() - 7);
  const nextStart = new Date(`${week.startDate}T00:00:00Z`);
  nextStart.setUTCDate(nextStart.getUTCDate() + 7);
  const prev = isoWeek(prevStart);
  const next = isoWeek(nextStart);

  const baseSearch: Record<string, string | undefined> = {
    q: q.q,
    availability: q.availability,
    masterStatus: q.masterStatus,
    language: q.language,
    currentDestinationId: q.currentDestinationId,
    sort: q.sort,
    order: q.order,
  };
  const filterLink = (over: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...baseSearch, ...over })) if (v) params.set(k, v);
    return `/availability?${params.toString()}`;
  };

  const rows: EditorRow[] = list.rows;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Weekly Availability</h1>
          <p>One record per teacher per week. Effective eligibility: master status first, then weekly state.</p>
        </div>
      </div>

      <div className="week-nav">
        <Link className="btn btn-secondary" href={filterLink({ year: String(prev.year), week: String(prev.week) })}>
          ‹ Week {prev.week}
        </Link>
        <div className="week-title">
          <strong>
            Week {week.isoWeekNumber} · {week.year}
          </strong>
          <span className="info-note">
            ISO week-year {week.year} · {week.startDate} → {week.endDate} ·{" "}
          </span>
          <StatusBadge status={week.status} />
          {correctionActive ? <span className="badge badge-amber">CORRECTION OPEN</span> : null}
        </div>
        <Link className="btn btn-secondary" href={filterLink({ year: String(next.year), week: String(next.week) })}>
          Week {next.week} ›
        </Link>
        {week.year !== cur.year || week.isoWeekNumber !== cur.week ? (
          <Link className="btn btn-secondary" href={filterLink({ year: String(cur.year), week: String(cur.week) })}>
            Current week
          </Link>
        ) : null}
        <form method="get" action="/availability" className="week-jump">
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

      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <form method="get" action="/availability" className="toolbar">
        <input type="hidden" name="year" value={week.year} />
        <input type="hidden" name="week" value={week.isoWeekNumber} />
        <input type="search" name="q" placeholder="Search teacher code or name…" defaultValue={q.q ?? ""} />
        <label className="toolbar-filter">
          <span>Availability</span>
          <select name="availability" defaultValue={q.availability ?? ""}>
            <option value="">All</option>
            {AVAILABILITY_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="toolbar-filter">
          <span>Master Status</span>
          <select name="masterStatus" defaultValue={q.masterStatus ?? ""}>
            <option value="">All</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </label>
        <label className="toolbar-filter">
          <span>Language</span>
          <select name="language" defaultValue={q.language ?? ""}>
            <option value="">All</option>
            <option value="FILIPINO">Filipino</option>
            <option value="ENGLISH">English</option>
          </select>
        </label>
        <label className="toolbar-filter">
          <span>Current Destination</span>
          <select name="currentDestinationId" defaultValue={q.currentDestinationId ?? ""}>
            <option value="">All</option>
            {dakoList.rows.map((d) => (
              <option key={d.id} value={d.id}>{d.name}{d.status === "DISABLED" ? " (disabled)" : ""}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">Apply</button>
        <Link className="btn btn-secondary" href={`/availability?year=${week.year}&week=${week.isoWeekNumber}`}>Reset</Link>
      </form>

      <p className="info-note">
        {list.total} teacher{list.total === 1 ? "" : "s"} shown · effective status counts master-inactive teachers as
        unschedulable regardless of any weekly value. No record = NOT_ENCODED = not a scheduling candidate.
      </p>

      <AvailabilityEditor
        weekId={week.id}
        rows={rows}
        weekStatus={week.status as "DRAFT" | "FINALIZED" | "PUBLISHED"}
        canWrite={canWrite}
        canEditNow={canWrite && (week.status !== "PUBLISHED" || (correctionActive && correctionHolder === user.userId))}
        canBeginCorrection={canWrite && isAdmin && week.status === "PUBLISHED" && !correctionActive}
        canEndCorrection={canWrite && isAdmin && correctionActive && correctionHolder === user.userId}
        fillBlankCount={fillBlankCount}
      />
    </>
  );
}
