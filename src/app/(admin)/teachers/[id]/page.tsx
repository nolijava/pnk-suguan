import Link from "next/link";
import { notFound } from "next/navigation";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { TeacherService, DakoService, AuditService, DestinationHistoryService } from "@/server/services";
import { NotFoundError } from "@/lib/errors";
import { StatusBadge, ConfirmDialog, Notice, StateCard } from "@/app/(admin)/_components";

export const dynamic = "force-dynamic";

function fmt(iso: string | null): string {
  return iso ?? "—";
}

export default async function TeacherDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("teachers.read");
  const { id } = await params;
  const sp = await searchParams;
  const notice = typeof sp.notice === "string" ? sp.notice : undefined;
  const error = typeof sp.error === "string" ? sp.error : undefined;

  let details;
  try {
    details = await TeacherService.getTeacherDetails(id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const t = details.teacher;
  const canWrite = user.roleCodes.includes("ADMIN") || user.roleCodes.includes("SCHEDULER");
  const [auditRows, activeDako, destinationHistory] = await Promise.all([
    AuditService.listAuditLogs({ entityType: "teacher", entityId: id, pageSize: 50 }),
    DakoService.listDako({ status: "ACTIVE", pageSize: 100 }),
    DestinationHistoryService.listForTeacher(id),
  ]);
  const destDisabled =
    t.currentDestinationId !== null &&
    details.currentDestination !== null &&
    details.currentDestination.status === "DISABLED";

  async function deactivateAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("teachers.write");
    await TeacherService.deactivateTeacher(String(formData.get("id")), String(formData.get("reason")), actor);
    revalidatePath(`/teachers/${id}`);
    redirect(`/teachers/${id}?notice=${encodeURIComponent("Teacher deactivated.")}`);
  }
  async function reactivateAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("teachers.write");
    await TeacherService.reactivateTeacher(String(formData.get("id")), actor);
    revalidatePath(`/teachers/${id}`);
    redirect(`/teachers/${id}?notice=${encodeURIComponent("Teacher reactivated.")}`);
  }
  async function destinationAction(formData: FormData) {
    "use server";
    const actor = await requirePermission("teachers.write");
    const raw = String(formData.get("newDestinationId") ?? "").trim();
    await TeacherService.changeCurrentDestination(
      String(formData.get("id")),
      raw === "" ? null : raw,
      String(formData.get("reason")),
      actor,
    );
    revalidatePath(`/teachers/${id}`);
    redirect(`/teachers/${id}?notice=${encodeURIComponent("Current Destination updated.")}`);
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>
            {t.firstName} {t.middleName ? `${t.middleName} ` : ""}
            {t.lastName} <StatusBadge status={t.status} />
          </h1>
          <p>
            {t.teacherCode}
            {details.age !== null ? ` · Age ${details.age} (computed from birthday)` : ""}
          </p>
        </div>
        <span className="actions-row">
          <Link className="btn btn-secondary" href="/teachers">All teachers</Link>
          {canWrite ? <Link className="btn btn-secondary" href={`/teachers/${id}/edit`}>Edit</Link> : null}
        </span>
      </div>

      {notice ? <Notice kind="success">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      <div className="detail-grid">
        <section className="card">
          <h2>Teacher information</h2>
          <dl className="detail-list">
            <dt>Teacher Code</dt><dd>{t.teacherCode}</dd>
            <dt>First Name</dt><dd>{t.firstName}</dd>
            <dt>Middle Name</dt><dd>{t.middleName ?? "—"}</dd>
            <dt>Last Name</dt><dd>{t.lastName}</dd>
            <dt>Birthday</dt><dd>{fmt(t.birthday)}</dd>
            <dt>Age</dt>
            <dd>{details.age !== null ? `${details.age} (always computed, never stored)` : "—"}</dd>
            <dt>Purok/Grupo</dt><dd>{t.purokGrupo ?? "—"}</dd>
            <dt>Date of Oath</dt><dd>{fmt(t.dateOfOath)}</dd>
            <dt>Language</dt><dd>{t.language}</dd>
            <dt>Remarks</dt><dd>{t.remarks ?? "—"}</dd>
            <dt>Created</dt><dd>{fmt(t.createdAt?.toISOString?.() ?? null)}</dd>
            <dt>Updated</dt><dd>{fmt(t.updatedAt?.toISOString?.() ?? null)}</dd>
          </dl>
        </section>

        <section className="card">
          <h2>Status</h2>
          <dl className="detail-list">
            <dt>Current Status</dt><dd><StatusBadge status={t.status} /></dd>
            {t.status === "INACTIVE" ? (
              <>
                <dt>Date Inactive</dt><dd>{fmt(t.dateInactive)}</dd>
                <dt>Inactive Reason</dt><dd>{t.inactiveReason ?? "—"}</dd>
                <dt>Inactive Duration</dt>
                <dd>
                  {details.inactiveFor
                    ? `Inactive for ${details.inactiveFor.years} year(s), ${details.inactiveFor.months} month(s) — computed from Date Inactive`
                    : "—"}
                </dd>
              </>
            ) : null}
          </dl>
          {canWrite ? (
            <div className="actions-row">
              {t.status === "ACTIVE" ? (
                <ConfirmDialog
                  triggerLabel="Deactivate"
                  className="btn btn-danger"
                  title="Deactivate teacher"
                  description="The teacher becomes Inactive and is excluded from future scheduling. Assignments, history, and availability remain untouched. A reason is required."
                  confirmLabel="Deactivate"
                  requireReason
                  hiddenFields={{ id }}
                  action={deactivateAction}
                />
              ) : (
                <ConfirmDialog
                  triggerLabel="Reactivate"
                  title="Reactivate teacher"
                  description="The teacher becomes Active again. This inactivity period ends; previous inactivity events remain permanently recoverable in the audit history."
                  confirmLabel="Reactivate"
                  hiddenFields={{ id }}
                  action={reactivateAction}
                />
              )}
            </div>
          ) : null}
          <p className="info-note">
            Historical inactivity events (dates + reasons of every past cycle) are preserved in the append-only audit trail below.
          </p>
        </section>

        <section className="card">
          <h2>Current Destination</h2>
          {t.currentDestinationId ? (
            <dl className="detail-list">
              <dt>Dako</dt>
              <dd>
                {details.currentDestination ? (
                  <Link href={`/dako/${details.currentDestination.id}`}>{details.currentDestination.name}</Link>
                ) : "(missing dako record)"}
              </dd>
              <dt>Dako Status</dt>
              <dd>
                {details.currentDestination ? <StatusBadge status={details.currentDestination.status} /> : "—"}
                {destDisabled ? (
                  <span className="warning-inline"> Current Destination dako is DISABLED — preserved as reference; select a new destination to replace it.</span>
                ) : null}
              </dd>
            </dl>
          ) : (
            <p>No Current Destination set.</p>
          )}
          <p className="info-note">
            Current Destination is a reference assignment — it never modifies weekly assignments, assignment history, or availability.
          </p>
          {canWrite ? (
            <form action={destinationAction} className="form-col">
              <input type="hidden" name="id" value={id} />
              <label className="field">
                <span>New Current Destination (ACTIVE dako only) — leave blank to clear</span>
                <select name="newDestinationId" defaultValue="">
                  <option value="">— none (clear Current Destination) —</option>
                  {activeDako.rows.map((d) => (
                    <option key={d.id} value={d.id}>{d.dakoCode} · {d.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Reason (required for set, change, or clear) <em aria-hidden="true"> *</em></span>
                <textarea name="reason" rows={2} required />
              </label>
              <div className="actions-row">
                <button type="submit" className="btn btn-primary">Update Current Destination</button>
              </div>
              <p className="info-note">Disabled dako are never selectable here; an existing disabled destination is preserved until explicitly changed.</p>
            </form>
          ) : null}
        </section>

        <section className="card">
          <div className="section-head">
            <div>
              <span className="eyebrow">Paper &amp; Archive</span>
              <h2>Destination History</h2>
            </div>
            <span className="chip">{destinationHistory.length} recorded period(s)</span>
          </div>
          {destinationHistory.length === 0 ? (
            <p className="info-note">
              No recorded destination periods yet. The first period starts when a Current Destination is set —
              historical dates are never invented.
            </p>
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
                      {p.dakoName ? <Link href={`/dako/${p.dakoId}`}>{p.dakoName}</Link> : "—"}
                    </span>
                    <span className={p.endDate ? "badge badge-gray" : "badge badge-green"}>
                      {p.endDate ? "Ended" : "Active"}
                    </span>
                  </div>
                  <dl className="archive-meta">
                    <div>
                      <dt>Dako</dt>
                      <dd>{p.dakoName ?? "—"}</dd>
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
                      <dd>{p.endDate ? "Ended" : "Active (current destination)"}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          )}
          <p className="info-note">
            One active period at a time; previous periods are preserved (never deleted) and survive inactivity or a disabled dako.
            Weekly Suguan assignments never create or modify these records.
          </p>
        </section>

        <section className="card">
          <h2>Recent audit history</h2>
          {auditRows.rows.length === 0 ? (
            <StateCard kind="empty" message="No audit entries for this teacher yet." />
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
