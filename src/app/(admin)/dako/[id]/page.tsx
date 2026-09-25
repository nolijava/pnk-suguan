import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { DakoService, AuditService, DestinationHistoryService } from "@/server/services";
import { NotFoundError } from "@/lib/errors";
import { dutyLabel } from "@/lib/duty";
import { StatusBadge, ConfirmDialog, Notice, StateCard } from "@/app/(admin)/_components";

export const dynamic = "force-dynamic";

function fmt(iso: string | null): string {
  return iso ?? "—";
}

export default async function DakoDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("dako.read");
  const { id } = await params;
  const sp = await searchParams;
  const notice = typeof sp.notice === "string" ? sp.notice : undefined;
  const error = typeof sp.error === "string" ? sp.error : undefined;

  let details;
  try {
    details = await DakoService.getDakoDetails(id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const d = details.dako;
  const canWrite = user.roleCodes.includes("ADMIN") || user.roleCodes.includes("SCHEDULER");
  const auditRows = await AuditService.listAuditLogs({ entityType: "dako", entityId: id, pageSize: 50 });
  const destinationHistory = await DestinationHistoryService.listForDako(id);

  // New Update #8 — the SAME normalized destination-history rows the teacher
  // pages read, grouped into the two duty slots. Nothing is derived from a
  // second source, and a missing holder is an honest empty state.
  const activeDestinado = destinationHistory.find((p) => !p.endDate && p.duty === "DESTINADO") ?? null;
  const activeKatuwang = destinationHistory.find((p) => !p.endDate && p.duty === "KATUWANG") ?? null;
  const activeUnlabelled = destinationHistory.filter((p) => !p.endDate && !p.duty);

  async function disableAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("dako.write");
    await DakoService.disableDako(String(formData.get("id")), String(formData.get("reason")), actor);
    revalidatePath(`/dako/${id}`);
    redirect(`/dako/${id}?notice=${encodeURIComponent("Dako disabled.")}`);
  }
  async function enableAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("dako.write");
    await DakoService.enableDako(String(formData.get("id")), actor);
    revalidatePath(`/dako/${id}`);
    redirect(`/dako/${id}?notice=${encodeURIComponent("Dako enabled.")}`);
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>
            {d.name} <StatusBadge status={d.status} />
          </h1>
          <p>{d.dakoCode}</p>
        </div>
        <span className="actions-row">
          <Link className="btn btn-secondary" href="/dako">All dako</Link>
          {canWrite ? <Link className="btn btn-secondary" href={`/dako/${id}/edit`}>Edit</Link> : null}
        </span>
      </div>

      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      <div className="detail-grid">
        <section className="card">
          <h2>Dako information</h2>
          <dl className="detail-list">
            <dt>Dako Code</dt><dd>{d.dakoCode}</dd>
            <dt>Dako Name</dt><dd>{d.name}</dd>
            <dt>Address</dt><dd>{d.address}</dd>
            <dt>Priority Dako</dt><dd>{d.isPriority ? "Yes" : "No"}</dd>
            <dt>Worship Day</dt><dd>{d.worshipDay}</dd>
            <dt>Worship Time</dt><dd>{d.worshipTime}</dd>
            <dt>Language</dt><dd>{d.language}</dd>
            <dt>Remarks</dt><dd>{d.remarks ?? "—"}</dd>
            <dt>Created</dt><dd>{fmt(d.createdAt?.toISOString?.() ?? null)}</dd>
            <dt>Updated</dt><dd>{fmt(d.updatedAt?.toISOString?.() ?? null)}</dd>
          </dl>
        </section>

        <section className="card">
          <h2>Anniversary</h2>
          <dl className="detail-list">
            <dt>Date Established</dt><dd>{d.dateEstablished}</dd>
            <dt>Years Completed</dt>
            <dd>{details.anniversary.yearsCompleted} (computed from Date Established, never stored)</dd>
            <dt>Next Anniversary</dt><dd>{details.anniversary.nextDate}</dd>
            <dt>Anniversary Year</dt><dd>{details.anniversary.anniversaryYear}</dd>
            <dt>Days Until</dt>
            <dd>
              {details.anniversary.daysUntil === 0
                ? "🎉 Today"
                : `${details.anniversary.daysUntil} day(s)`}
            </dd>
          </dl>
        </section>

        <section className="card">
          <h2>Status</h2>
          <dl className="detail-list">
            <dt>Current Status</dt><dd><StatusBadge status={d.status} /></dd>
            {d.status === "DISABLED" ? (
              <>
                <dt>Date Disabled</dt><dd>{fmt(d.dateDisabled)}</dd>
                <dt>Disable Reason</dt><dd>{d.disableReason ?? "—"}</dd>
              </>
            ) : null}
          </dl>
          {canWrite ? (
            <div className="actions-row">
              {d.status === "ACTIVE" ? (
                <ConfirmDialog
                  triggerLabel="Disable"
                  className="btn btn-danger"
                  title="Disable dako"
                  description="The dako becomes Disabled and is excluded from new Current Destination selections and future scheduling. Existing teacher destinations, assignments, history, and availability remain untouched. A reason is required."
                  confirmLabel="Disable"
                  requireReason
                  hiddenFields={{ id }}
                  action={disableAction}
                />
              ) : (
                <ConfirmDialog
                  triggerLabel="Enable"
                  title="Enable dako"
                  description={`Restore ${d.name} to Active?`}
                  confirmLabel="Enable"
                  hiddenFields={{ id }}
                  action={enableAction}
                />
              )}
            </div>
          ) : null}
        </section>

        <section className="card">
          <h2>Current Assignment</h2>
          <dl className="detail-list">
            <dt>Destinado</dt>
            <dd>
              {activeDestinado ? (
                <Link href={`/teachers/${activeDestinado.teacherId}`}>{activeDestinado.teacherName}</Link>
              ) : (
                <span className="info-note">No Destinado currently assigned.</span>
              )}
            </dd>
            {activeDestinado ? (
              <>
                <dt>Destinado since</dt>
                <dd>{activeDestinado.startDate}</dd>
              </>
            ) : null}
            <dt>Katuwang</dt>
            <dd>
              {activeKatuwang ? (
                <Link href={`/teachers/${activeKatuwang.teacherId}`}>{activeKatuwang.teacherName}</Link>
              ) : (
                <span className="info-note">No Katuwang currently assigned.</span>
              )}
            </dd>
            {activeKatuwang ? (
              <>
                <dt>Katuwang since</dt>
                <dd>{activeKatuwang.startDate}</dd>
              </>
            ) : null}
          </dl>
          {activeUnlabelled.length > 0 ? (
            <p className="info-note">
              {activeUnlabelled.length} currently destined teacher(s) with no recorded duty:{" "}
              {activeUnlabelled.map((p, i) => (
                <span key={p.id}>
                  {i > 0 ? ", " : ""}
                  <Link href={`/teachers/${p.teacherId}`}>{p.teacherName}</Link>
                </span>
              ))}
              . Set the duty on their Current Destination to place them in a slot.
            </p>
          ) : null}
          <p className="info-note">
            One active Destinado and one active Katuwang at a time. Both slots read the same destination-history
            records shown on the teacher pages, so the two views can never disagree.
          </p>
        </section>

        <section className="card">
          <div className="section-head">
            <div>
              <span className="eyebrow">Paper &amp; Archive</span>
              <h2>Teacher Destination History</h2>
            </div>
            <span className="chip">{destinationHistory.length} recorded period(s)</span>
          </div>
          {destinationHistory.length === 0 ? (
            <p className="info-note">No recorded destination periods for this dako yet — records start when a teacher is destined here.</p>
          ) : (
            <div className="archive-list">
              {destinationHistory.map((p, i) => (
                <article
                  className="archive-item"
                  key={p.id}
                  data-active={p.endDate ? "false" : "true"}
                  style={{ "--i": i } as React.CSSProperties}
                >
                  <div className="archive-head">
                    <span className="archive-title">
                      <Link href={`/teachers/${p.teacherId}`}>{p.teacherName}</Link>
                    </span>
                    <span className={p.endDate ? "badge badge-gray" : "badge badge-green"}>
                      {p.endDate ? "Ended" : "Active"}
                    </span>
                  </div>
                  <dl className="archive-meta">
                    <div>
                      <dt>Teacher</dt>
                      <dd>{p.teacherName}</dd>
                    </div>
                    {/* New Update #8 — the duty recorded for THIS period. */}
                    <div>
                      <dt>Duty</dt>
                      <dd>{dutyLabel(p.duty)}</dd>
                    </div>
                    <div>
                      <dt>Date Destined</dt>
                      <dd>{p.startDate}</dd>
                    </div>
                    <div>
                      <dt>Date Ended</dt>
                      <dd>{p.endDate ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{p.endDate ? "Ended" : p.duty ? `Active (current ${dutyLabel(p.duty)})` : "Active (duty not recorded)"}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          )}
          <p className="info-note">
            The same normalized destination-history records shown on the teacher page — one active holder per duty slot
            (Destinado, Katuwang); prior records are preserved together with the duty held there. Weekly Suguan
            assignments never create or modify these records.
          </p>
        </section>

        <section className="card">
          <h2>Recent audit history</h2>
          {auditRows.rows.length === 0 ? (
            <StateCard kind="empty" message="No audit entries for this dako yet." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>When</th><th>Action</th><th>By</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {auditRows.rows.map((a) => (
                    <tr key={a.id}>
                      <td>{a.createdAt?.toISOString?.() ?? ""}</td>
                      <td>{a.action}</td>
                      <td>{a.userEmail ?? a.userId}</td>
                      <td>{a.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
