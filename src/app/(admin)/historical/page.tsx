import Link from "next/link";
import { requirePermission } from "@/server/auth/guard";
import { HistoricalService, DakoService, TeacherService } from "@/server/services";
import { hasPermission } from "@/server/auth/permissions";
import { StateCard } from "../_components/state-card";
import { HistoricalClient, type HistoricalRowExisting } from "./historical-client";
import { getDb } from "@/server/db/client";
import { assignments, dako, teachers } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  SUGO: "SUGO",
  RESERBA: "RESERBA",
  RESERBA_II: "RESERBA II",
};

export default async function HistoricalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("assignments.read");
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

  const canWrite = hasPermission(user.roleCodes, "assignments.write");
  const isAdmin = user.roleCodes.includes("ADMIN");
  const goLive = HistoricalService.goLive();

  const weeks = await HistoricalService.listHistoricalWeeks();
  const selected = weeks.find((w) => w.id === flat.weekId) ?? null;

  // Master rows for the editor (read-only here; the service re-validates).
  const [dakoList, teacherList] = await Promise.all([DakoService.listDako({}), TeacherService.listTeachers({})]);
  const dakos = dakoList.rows.map((d) => ({ id: d.id, name: d.name, language: d.language, status: d.status }));
  const teachersList = teacherList.rows.map((t) => ({
    id: t.id,
    fullName: [t.firstName, t.middleName, t.lastName].filter(Boolean).join(" "),
    teacherCode: t.teacherCode,
    language: t.language,
    status: t.status,
  }));

  let existing: HistoricalRowExisting[] = [];
  if (selected) {
    const rows = await getDb()
      .select({
        id: assignments.id,
        dakoId: assignments.dakoId,
        dakoName: dako.name,
        teacherId: assignments.teacherId,
        teacherCode: teachers.teacherCode,
        firstName: teachers.firstName,
        middleName: teachers.middleName,
        lastName: teachers.lastName,
        assignmentType: assignments.assignmentType,
      })
      .from(assignments)
      .innerJoin(dako, eq(dako.id, assignments.dakoId))
      .innerJoin(teachers, eq(teachers.id, assignments.teacherId))
      .where(and(eq(assignments.weekId, selected.id), eq(assignments.assignmentSource, "HISTORICAL")));
    existing = rows.map((r) => ({
      id: r.id,
      dakoId: r.dakoId,
      dakoName: r.dakoName,
      teacherId: r.teacherId,
      teacherName: [r.firstName, r.middleName, r.lastName].filter(Boolean).join(" "),
      teacherCode: r.teacherCode,
      assignmentType: r.assignmentType,
    }));
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Historical Backfill</h1>
          <p>
            Actual Suguan schedules before the scheduling go-live ({"W"}{goLive.week} · {goLive.year}) are
            recorded here — never generated. These weeks never appear in the normal Generate workflow.
          </p>
        </div>
      </div>

      {weeks.length === 0 ? (
        <StateCard kind="empty" message="No pre-go-live weeks exist. Weeks are created from the Weeks admin." />
      ) : (
        <>
          <div className="week-nav">
            <form method="get" action="/historical" className="week-jump">
              <label>
                Historical week
                <select name="weekId" defaultValue={selected?.id ?? ""}>
                  <option value="">— select a week —</option>
                  {weeks.map((w) => (
                    <option key={w.id} value={w.id}>
                      W{String(w.isoWeekNumber).padStart(2, "0")} · {w.year} {w.recorded ? "· recorded" : "· not recorded"}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="btn btn-secondary">Open</button>
            </form>
          </div>

          {selected ? (
            <HistoricalClient
              weekId={selected.id}
              weekLabel={`W${String(selected.isoWeekNumber).padStart(2, "0")} · ${selected.year}`}
              canWrite={canWrite}
              isAdmin={isAdmin}
              dakos={dakos}
              teachers={teachersList}
              existing={existing}
            />
          ) : (
            <p className="info-note">Select a historical week above to view or record its actual schedule.</p>
          )}

          <p>
            <Link className="btn btn-secondary" href="/schedule">Go to normal Weekly Schedule</Link>
          </p>
        </>
      )}
    </>
  );
}
