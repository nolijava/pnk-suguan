"use client";

import { useState, useTransition } from "react";
import { StatusBadge } from "../_components/status-badge";

export interface SlotRow {
  id: string | null;
  dakoId: string;
  dakoName: string;
  dakoCode: string;
  assignmentType: string;
  teacherName: string | null;
  teacherCode: string | null;
  source: string | null;
  status: string | null;
  reasonCode: string | null;
  reason: string | null;
  occupiedByManual: boolean;
}

export interface ScheduleActionsProps {
  weekId: string;
  weekStatus: "DRAFT" | "FINALIZED" | "PUBLISHED";
  canWrite: boolean;
  canGenerate: boolean;
  canFinalize: boolean;
  canPublish: boolean;
  absenceCount: number;
  rows: SlotRow[];
  summary: { dakos: number; sugoAssigned: number; reserbaAssigned: number; reserbaIiAssigned: number; unassigned: number } | null;
}

const TYPE_LABEL: Record<string, string> = {
  SUGO: "SUGO",
  RESERBA: "RESERBA",
  RESERBA_II: "RESERBA II",
};

/**
 * §6 pre-generation warning flow: Generate → fresh server count (already
 * rendered server-side into absenceCount; re-fetched at click time so it is
 * never cached) → confirm dialog when N > 0 → POST /api/scheduling/generate.
 * Override flow (§15): eligibility-check first, display violated rules,
 * mandatory reason, POST/PATCH assignment endpoints.
 */
export function ScheduleActions({
  weekId,
  weekStatus,
  canWrite,
  canGenerate,
  canFinalize,
  canPublish,
  absenceCount,
  rows,
  summary,
}: ScheduleActionsProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [showAbsentWarning, setShowAbsentWarning] = useState(false);
  const [freshCount, setFreshCount] = useState(0);
  const [override, setOverride] = useState<{ row: SlotRow } | null>(null);
  const [overrideRules, setOverrideRules] = useState<string[] | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideErr, setOverrideErr] = useState<string | null>(null);

  const locked = weekStatus !== "DRAFT";
  const isAdmin = canFinalize && canPublish; // finalize+publish ⇒ ADMIN

  async function refreshAbsenceCount(): Promise<number> {
    const res = await fetch(`/api/scheduling/previous-week-absences?weekId=${weekId}`);
    const body = await res.json();
    return res.ok ? body.data.count : 0;
  }

  function generate() {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/scheduling/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ weekId }),
        });
        const body = await res.json();
        if (!res.ok) {
          setMessage({ kind: "error", text: body?.error?.message ?? "generation failed" });
        } else {
          setMessage({
            kind: "success",
            text: body.data.regenerated
              ? `Regenerated ${body.data.inserted} assignment(s). Reloading…`
              : `Generated ${body.data.inserted} assignment(s). Reloading…`,
          });
          window.location.reload();
        }
      } catch {
        setMessage({ kind: "error", text: "network error — generation not executed" });
      }
    });
  }

  function onGenerateClick() {
    setMessage(null);
    startTransition(async () => {
      const n = await refreshAbsenceCount();
      if (n > 0) {
        setFreshCount(n);
        setShowAbsentWarning(true);
      } else {
        generate();
      }
    });
  }

  function finalize() {
    setMessage(null);
    startTransition(async () => {
      const res = await fetch(`/api/weeks/${weekId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "FINALIZED" }),
      });
      const body = await res.json();
      if (!res.ok) setMessage({ kind: "error", text: body?.error?.message ?? "finalize failed" });
      else window.location.reload();
    });
  }

  function publish() {
    setMessage(null);
    startTransition(async () => {
      const res = await fetch(`/api/weeks/${weekId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "PUBLISHED" }),
      });
      const body = await res.json();
      if (!res.ok) setMessage({ kind: "error", text: body?.error?.message ?? "publish failed" });
      else window.location.reload();
    });
  }

  async function runEligibilityCheck(teacherId: string, dakoId: string): Promise<string[]> {
    const res = await fetch("/api/scheduling/eligibility-check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekId, dakoId, teacherId }),
    });
    const body = await res.json();
    return res.ok ? body.data.violatedRules : [];
  }
  void runEligibilityCheck;

  function openOverride(row: SlotRow) {
    setOverride({ row });
    setOverrideRules([]);
    setOverrideReason("");
    setOverrideErr(null);
  }

  function submitOverride() {
    if (!override) return;
    if (!overrideReason.trim()) {
      setOverrideErr("A non-empty reason is required for an override.");
      return;
    }
    const teacherCode = prompt(
      "Enter the TEACHER CODE of the replacement teacher:",
      override.row.teacherCode ?? "",
    );
    if (!teacherCode || !teacherCode.trim()) {
      setOverrideErr("Replacement teacher code is required.");
      return;
    }
    setMessage(null);
    startTransition(async () => {
      try {
        // 1) resolve teacher id from code
        const lookup = await fetch(`/api/teachers?q=${encodeURIComponent(teacherCode.trim())}&pageSize=5`);
        const lbody = await lookup.json();
        const hit = lbody?.data?.rows?.find(
          (r: { teacherCode: string }) => r.teacherCode.toUpperCase() === teacherCode.trim().toUpperCase(),
        );
        if (!hit) {
          setOverrideErr(`No teacher found with code ${teacherCode.trim()}.`);
          return;
        }
        // 2) eligibility check — violated rules displayed before confirmation
        const violated: string[] = await runEligibilityCheck(hit.id, override.row.dakoId!);
        if (violated.length > 0 && !confirm(
          `This override violates: ${violated.join(", ")}. Proceed intentionally with the mandatory reason?`,
        )) {
          setOverrideErr(null);
          return;
        }
        // 3) apply
        const res = override.row.id
          ? await fetch(`/api/assignments/${override.row.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ teacherId: hit.id, reason: `[RULES: ${violated.join(", ")}] ${overrideReason.trim()}`.replace("[RULES: ] ", "") }),
            })
          : await fetch("/api/assignments", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                weekId, dakoId: override.row.dakoId, teacherId: hit.id,
                assignmentType: override.row.assignmentType,
                overrideReason: overrideReason.trim() || undefined,
              }),
            });
        const body = await res.json();
        if (!res.ok) {
          setOverrideErr(body?.error?.message ?? "override failed");
          return;
        }
        setOverride(null);
        setMessage({ kind: "success", text: "Override applied. Reloading…" });
        window.location.reload();
      } catch {
        setOverrideErr("network error — override not applied");
      }
    });
  }

  return (
    <>
      <div className="save-bar">
        <div className="info-note">
          {summary
            ? `${summary.dakos} active dako(s) · SUGO ${summary.sugoAssigned} · RESERBA ${summary.reserbaAssigned} · RESERBA II ${summary.reserbaIiAssigned} · unassigned ${summary.unassigned}`
            : "Plan unavailable."}
          {absenceCount > 0 ? ` · ${absenceCount} teacher(s) ABSENT last week (hard-excluded from generation).` : ""}
        </div>
        <div className="actions-row">
          {canGenerate && !locked ? (
            <button type="button" className="btn btn-primary" onClick={onGenerateClick} disabled={pending}>
              {rows.some((r) => r.source === "AUTO") ? "Regenerate schedule" : "Generate schedule"}
            </button>
          ) : null}
          {canFinalize && weekStatus === "DRAFT" ? (
            <button type="button" className="btn btn-secondary" onClick={finalize} disabled={pending}>Finalize</button>
          ) : null}
          {canPublish && weekStatus === "FINALIZED" ? (
            <button type="button" className="btn btn-secondary" onClick={publish} disabled={pending}>Publish</button>
          ) : null}
        </div>
      </div>

      {message ? <p className={message.kind === "success" ? "notice" : "error"}>{message.text}</p> : null}
      {locked ? (
        <p className="info-note">
          {weekStatus === "PUBLISHED"
            ? "PUBLISHED — this schedule is permanently immutable."
            : "FINALIZED — generation is locked; only publish or ADMIN DRAFT-unlock applies."}
        </p>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Dako</th>
              <th>Type</th>
              <th>Teacher</th>
              <th>Source</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6}>No slots computed for this week.</td></tr>
            ) : (
              rows.map((r, i) => (
                <tr key={`${r.dakoCode}|${r.assignmentType}|${i}`} className={r.occupiedByManual ? "row-manual" : ""}>
                  <td>{r.dakoName} <span className="info-note">({r.dakoCode})</span></td>
                  <td>{TYPE_LABEL[r.assignmentType] ?? r.assignmentType}</td>
                  {r.teacherName ? (
                    <td>{r.teacherName} <span className="info-note">({r.teacherCode})</span></td>
                  ) : (
                    <td>
                      <span className="badge badge-gray">UNASSIGNED</span>
                      {r.reasonCode ? (
                        <div className="info-note">
                          {r.reasonCode}: {r.reason}
                        </div>
                      ) : null}
                    </td>
                  )}
                  <td>{r.source ? <span className="badge badge-gray">{r.source}</span> : <span className="info-note">—</span>}</td>
                  <td>{r.status ? <StatusBadge status={r.status} /> : <span className="info-note">—</span>}</td>
                  <td>
                    {canWrite && !locked && r.id ? (
                      <button type="button" className="btn btn-secondary" onClick={() => openOverride(r)}>Override…</button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showAbsentWarning ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Previous Week Availability Notice">
          <div className="modal">
            <h2>Previous Week Availability Notice</h2>
            <p>
              <strong>{freshCount}</strong> teacher(s) were marked ABSENT last week.
            </p>
            <p>These teachers will be excluded from this week&apos;s automatic schedule generation.</p>
            <p>Would you like to proceed?</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setShowAbsentWarning(false); window.location.href = `/availability?year=${new URLSearchParams(window.location.search).get("year") ?? ""}&week=${new URLSearchParams(window.location.search).get("week") ?? ""}`; }}>
                Review/Modify Availability First
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowAbsentWarning(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => { setShowAbsentWarning(false); generate(); }} disabled={pending}>
                Proceed with Schedule Generation
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {override ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Manual assignment override">
          <div className="modal">
            <h2>Manual Assignment Override</h2>
            <p>
              Replacing the <strong>{override.row.assignmentType}</strong> slot of{" "}
              <strong>{override.row.dakoName}</strong> (currently: {override.row.teacherName ?? "unassigned"}).
            </p>
            <p className="info-note">
              Violated rules (if any) are checked server-side and shown before you confirm. A non-empty reason is mandatory and audited.
            </p>
            {overrideErr ? <p className="error">{overrideErr}</p> : null}
            <div className="form-col">
              <label>
                Reason (required, audited)
                <textarea rows={3} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} autoFocus />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setOverride(null)} disabled={pending}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={submitOverride} disabled={pending}>Check &amp; Apply</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
