"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "./status-badge";
import { Modal } from "./modal";

export interface EditorRow {
  teacherId: string;
  teacherCode: string;
  fullName: string;
  purokGrupo: string | null;
  language: string;
  masterStatus: string;
  weeklyStatus: string | null;
  reason: string | null;
  remarks: string | null;
  effectiveStatus: string;
  currentDestinationName: string | null;
  currentDestinationStatus: string | null;
  /** Update #14 — real assignment label(s) for this week ("Not Assigned" when none). */
  assignedAs: string;
}

export interface AvailabilityEditorProps {
  weekId: string;
  rows: EditorRow[];
  weekStatus: "DRAFT" | "FINALIZED" | "PUBLISHED";
  canWrite: boolean;
  /** Permission + week-lock state + correction-grant ownership combined. */
  canEditNow: boolean;
  /** ADMIN and no correction currently open → may begin one. */
  canBeginCorrection: boolean;
  /** ADMIN holding the active correction → may end it. */
  canEndCorrection: boolean;
  fillBlankCount: number;
  /**
   * Update #24 — the opt-in “Fix availability” guide, reached from a BLOCKED
   * week (matrix mark or generation block notice via `?fix=1`). It adds the
   * blocking sentence and highlights the teachers still needing availability;
   * it never widens what may be written.
   */
  fixRequested?: boolean;
  /** The generation gate's own blocking sentence (identical wording). */
  readinessMessage?: string | null;
  /** “Show only the missing” link (the NOT_ENCODED filter for this week). */
  missingFilterHref?: string;
}

type Draft = { status: string | null; reason: string };

/** Master-INACTIVE rows are locked: master status always wins (§8/§14). */
function lockedRow(row: EditorRow): boolean {
  return row.masterStatus === "INACTIVE";
}

/**
 * Weekly encoding grid (§10/§13): inline status + reason per row, batched save
 * (one transaction server-side), dirty tracking, clear/reset, Fill Blanks
 * confirm dialog, PUBLISHED-lock banner with ADMIN correction window.
 */
export function AvailabilityEditor({
  weekId,
  rows,
  weekStatus,
  canWrite,
  canEditNow,
  canBeginCorrection,
  canEndCorrection,
  fillBlankCount,
  fixRequested = false,
  readinessMessage = null,
  missingFilterHref,
}: AvailabilityEditorProps) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [showFillConfirm, setShowFillConfirm] = useState(false);
  const [showCorrection, setShowCorrection] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const editable = canEditNow;
  const dirty = useMemo(
    () => Object.entries(drafts).filter(([, d]) => d.status !== null || d.reason.trim() !== ""),
    [drafts],
  );

  /**
   * Update #24 — the teachers still blocking generation, i.e. exactly the set
   * the gate reports missing and Fill Blanks targets: master-ACTIVE with no
   * availability row for this week (effective status NOT_ENCODED). Master-
   * INACTIVE teachers can never appear here (their effective status is
   * INACTIVE_MASTER), so the highlight never points at an unusable row.
   */
  const needsAvailability = useMemo(
    () =>
      new Set(
        rows
          .filter((r) => r.masterStatus === "ACTIVE" && r.effectiveStatus === "NOT_ENCODED")
          .map((r) => r.teacherId),
      ),
    [rows],
  );
  const showFixGuide = fixRequested && fillBlankCount > 0;
  // Rows the CURRENT filters hide are still counted by the banner (the count is
  // the server's), so say so rather than silently mislabelling the highlight.
  const hiddenByFilters = Math.max(fillBlankCount - needsAvailability.size, 0);

  function setDraft(teacherId: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [teacherId]: { status: null, reason: "", ...prev[teacherId], ...patch } }));
    setMessage(null);
  }

  function resetUnsaved() {
    setDrafts({});
    setMessage(null);
  }

  function saveAll() {
    if (dirty.length === 0) return;
    setMessage(null);
    startTransition(async () => {
      const changes = dirty.map(([teacherId, d]) => {
        const row = rows.find((r) => r.teacherId === teacherId)!;
        const status = d.status ?? row.weeklyStatus ?? "AVAILABLE";
        return {
          teacherId,
          weekId,
          availabilityStatus: status,
          ...(status === "ABSENT" ? { reason: d.reason.trim() } : {}),
        };
      });
      try {
        const res = await fetch("/api/availability/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ changes }),
        });
        const body = await res.json();
        if (!res.ok) {
          const detail = body?.error?.issues?.[0]?.message ?? body?.error?.message ?? "save failed";
          setMessage({ kind: "error", text: detail });
        } else {
          setMessage({ kind: "success", text: `Saved ${body.data.saved} change(s)${body.data.skipped ? `, ${body.data.skipped} unchanged skipped` : ""}.` });
          setDrafts({});
          // Update #14 — refresh the table in place (no full-page reload).
          router.refresh();
        }
      } catch {
        setMessage({ kind: "error", text: "network error — changes not saved" });
      }
    });
  }

  function fillBlanks() {
    setShowFillConfirm(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/availability/fill-blanks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ weekId }),
        });
        const body = await res.json();
        if (!res.ok) {
          setMessage({ kind: "error", text: body?.error?.message ?? "fill blanks failed" });
        } else {
          setMessage({ kind: "success", text: `Created ${body.data.created} AVAILABLE record(s).` });
          router.refresh();
        }
      } catch {
        setMessage({ kind: "error", text: "network error — fill blanks not executed" });
      }
    });
  }

  function toggleCorrection(reason: string, action: "begin" | "end") {
    setShowCorrection(false);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/availability/${weekId}/correction`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, ...(action === "begin" ? { reason } : {}) }),
        });
        const body = await res.json();
        if (!res.ok) {
          setMessage({ kind: "error", text: body?.error?.issues?.[0]?.message ?? body?.error?.message ?? "correction failed" });
        } else {
          window.location.reload();
        }
      } catch {
        setMessage({ kind: "error", text: "network error — correction not applied" });
      }
    });
  }

  return (
    <div className="avail-editor">
      {weekStatus === "PUBLISHED" ? (
        <div className="lock-banner" role="status">
          <strong>PUBLISHED</strong> — this week&apos;s schedule is locked and availability editing is
          {canEndCorrection ? (
            <>
              {" "}
              temporarily open <strong>for this ADMIN correction session</strong> only. The week stays PUBLISHED.
            </>
          ) : (
            " locked."
          )}
          {canBeginCorrection ? (
            <button type="button" className="btn btn-secondary" onClick={() => setShowCorrection(true)} disabled={pending}>
              Unlock availability for correction
            </button>
          ) : null}
          {canEndCorrection ? (
            <button type="button" className="btn btn-secondary" onClick={() => toggleCorrection("", "end")} disabled={pending}>
              End correction (re-lock)
            </button>
          ) : null}
        </div>
      ) : null}

      {message ? <p className={message.kind === "success" ? "notice" : "error"}>{message.text}</p> : null}

      {/* Update #24 — “Fix availability” guide. Shown only when this page was
          opened from a BLOCKED week AND something is still missing, so it
          disappears by itself once the gaps are filled. */}
      {showFixGuide ? (
        <div className="block-notice fix-availability" role="alert">
          <strong>Weekly Availability Required</strong>
          <p>
            {readinessMessage ??
              `${fillBlankCount} teacher(s) still have no availability for this week, so generation is blocked.`}
          </p>
          <p className="info-note">
            {needsAvailability.size} highlighted row{needsAvailability.size === 1 ? "" : "s"} below
            {needsAvailability.size === 1 ? " needs" : " need"} encoding
            {hiddenByFilters > 0
              ? `; ${hiddenByFilters} more ${hiddenByFilters === 1 ? "is" : "are"} hidden by the current filters.`
              : "."}
          </p>
          <div className="block-notice-actions">
            {editable && canWrite && fillBlankCount > 0 ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowFillConfirm(true)}
                disabled={pending}
              >
                Fill {fillBlankCount} as AVAILABLE
              </button>
            ) : null}
            {missingFilterHref ? (
              <Link className="btn btn-secondary" href={missingFilterHref}>
                Show only the missing
              </Link>
            ) : null}
            <span className="info-note">…or encode each highlighted teacher below.</span>
          </div>
        </div>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Teacher Code</th>
              <th>Name</th>
              <th>Purok/Grupo</th>
              <th>Language</th>
              <th>Current Destination</th>
              <th>Assigned</th>
              <th>Master Status</th>
              <th>Availability (this week)</th>
              <th>Reason / Remarks</th>
              <th>Effective</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const d = drafts[row.teacherId];
              const locked = lockedRow(row);
              const rowEditable = editable && !locked;
              const shownStatus = d?.status ?? row.weeklyStatus;
              const shownReason = d ? d.reason : row.reason ?? "";
              const isAbsentNow = shownStatus === "ABSENT";
              // Update #24 — highlight the rows still blocking generation. A row
              // the operator is already editing wins the tint (row-dirty), so
              // their in-progress work stays the most prominent thing.
              const needsEncoding = fixRequested && needsAvailability.has(row.teacherId) && !d?.status;
              const rowClass =
                [locked ? "row-locked" : d?.status ? "row-dirty" : undefined, needsEncoding ? "row-needs-availability" : undefined]
                  .filter(Boolean)
                  .join(" ") || undefined;
              return (
                <tr key={row.teacherId} className={rowClass}>
                  <td>{row.teacherCode}</td>
                  <td>{row.fullName}</td>
                  <td>{row.purokGrupo ?? "—"}</td>
                  <td>{row.language}</td>
                  <td>
                    {row.currentDestinationName
                      ? `${row.currentDestinationName}${row.currentDestinationStatus === "DISABLED" ? " (DISABLED)" : ""}`
                      : "—"}
                  </td>
                  {/* Update #14 — backend assignment data only; ABSENT/INACTIVE/NOT_ENCODED stay in their own columns. */}
                  <td>{row.assignedAs}</td>
                  <td>
                    <StatusBadge status={row.masterStatus} />
                    {locked ? <span className="lock-note"> master-inactive — not schedulable</span> : null}
                  </td>
                  <td>
                    {rowEditable ? (
                      <>
                        <select
                          aria-label={`Availability for ${row.teacherCode}`}
                          value={shownStatus ?? ""}
                          onChange={(e) => setDraft(row.teacherId, { status: e.target.value || null })}
                          disabled={pending}
                        >
                          <option value="">— not encoded —</option>
                          <option value="AVAILABLE">AVAILABLE</option>
                          <option value="ABSENT">ABSENT</option>
                          <option value="INACTIVE">INACTIVE</option>
                        </select>
                        {needsEncoding ? <span className="needs-availability-note">needs availability</span> : null}
                      </>
                    ) : (
                      <span>{shownStatus ?? "—"}</span>
                    )}
                  </td>
                  <td>
                    {rowEditable && isAbsentNow ? (
                      <input
                        aria-label={`Absence reason for ${row.teacherCode}`}
                        value={shownReason}
                        onChange={(e) => setDraft(row.teacherId, { reason: e.target.value })}
                        placeholder="reason (required for ABSENT)"
                        disabled={pending}
                        style={{ minWidth: 180 }}
                      />
                    ) : (
                      <span className="muted">{row.reason ?? row.remarks ?? "—"}</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${row.effectiveStatus === "AVAILABLE" ? "badge-green" : row.effectiveStatus === "NOT_ENCODED" ? "badge-gray" : "badge-amber"}`}>
                      {row.effectiveStatus}
                    </span>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty-state">No teachers match the current filters.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {canWrite && (editable || dirty.length > 0) ? (
        <div className="save-bar">
          <span>
            {dirty.length} unsaved change{dirty.length === 1 ? "" : "s"}
          </span>
          <button type="button" className="btn btn-secondary" onClick={resetUnsaved} disabled={pending || dirty.length === 0}>
            Clear unsaved
          </button>
          {editable && fillBlankCount > 0 ? (
            <button type="button" className="btn btn-secondary" onClick={() => setShowFillConfirm(true)} disabled={pending}>
              Fill blanks as AVAILABLE ({fillBlankCount})
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={saveAll} disabled={pending || dirty.length === 0}>
            {pending ? "Saving…" : `Save ${dirty.length || ""}`.trim()}
          </button>
        </div>
      ) : null}

      {showFillConfirm ? (
        <Modal open onClose={() => setShowFillConfirm(false)}>
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Fill blanks confirmation">
          <div className="modal">
            <h2>Fill blanks as AVAILABLE</h2>
            <p>
              This will create <strong>{fillBlankCount}</strong> AVAILABLE record(s) for master-ACTIVE teachers who have
              no availability record for this week.
              <br />
              Existing records will <strong>not</strong> be changed. Master-INACTIVE teachers are excluded.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowFillConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={fillBlanks} disabled={pending}>
                Create {fillBlankCount} record(s)
              </button>
            </div>
          </div>
        </div>
        </Modal>
      ) : null}

      {showCorrection ? <CorrectionModal onCancel={() => setShowCorrection(false)} onSubmit={(r) => toggleCorrection(r, "begin")} pending={pending} /> : null}
    </div>
  );
}

function CorrectionModal({
  onCancel,
  onSubmit,
  pending,
}: {
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open onClose={onCancel}>
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Unlock availability for correction">
      <div className="modal">
        <h2>Unlock availability for correction</h2>
        <p>
          The week remains <strong>PUBLISHED</strong> and the schedule stays locked. This opens availability editing only,
          for this ADMIN session, for a limited time. A reason is required and the action is audited.
        </p>
        {error ? <p className="error">{error}</p> : null}
        <label className="field">
          <span>
            Reason (required)<em aria-hidden="true"> *</em>
          </span>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() => {
              if (!reason.trim()) {
                setError("Reason is required.");
                return;
              }
              onSubmit(reason.trim());
            }}
          >
            {pending ? "Working…" : "Begin correction"}
          </button>
        </div>
      </div>
    </div>
    </Modal>
  );
}
