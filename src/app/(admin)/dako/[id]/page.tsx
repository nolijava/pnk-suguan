import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { DakoService, AuditService, DestinationHistoryService } from "@/server/services";
import { NotFoundError } from "@/lib/errors";
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
            <dt>Purok/Grupo</dt><dd>{d.purokGrupo ?? "—"}</dd>
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
          <h2>Teacher Destination History</h2>
          {destinationHistory.length === 0 ? (
            <p>No recorded destination periods for this dako yet — records start when a teacher is destined here.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Teacher</th><th>Date Destined</th><th>Date Ended</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {destinationHistory.map((p) => (
                    <tr key={p.id}>
                      <td><Link href={`/teachers/${p.teacherId}`}>{p.teacherName}</Link></td>
                      <td>{p.startDate}</td>
                      <td>{p.endDate ?? "—"}</td>
                      <td>{p.endDate ? "Ended" : <strong>Active</strong>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="info-note">
            The same normalized destination-history records shown on the teacher page — one active destined teacher at a
            time; prior records preserved. Weekly Suguan assignments never create or modify these records.
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
