"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "../_components/modal";

export interface HistoricalWeek {
  id: string;
  year: number;
  isoWeekNumber: number;
  status: string;
  recorded: boolean;
}

export interface HistoricalDako {
  id: string;
  name: string;
  language: string;
  status: string;
}
export interface HistoricalTeacher {
  id: string;
  fullName: string;
  teacherCode: string;
  language: string;
  status: string;
}
export interface HistoricalRowExisting {
  id: string;
  dakoId: string;
  dakoName: string;
  teacherId: string;
  teacherName: string;
  teacherCode: string;
  assignmentType: string;
}

const TYPES = ["SUGO", "RESERBA", "RESERBA_II"] as const;
const TYPE_LABEL: Record<string, string> = {
  SUGO: "SUGO",
  RESERBA: "RESERBA",
  RESERBA_II: "RESERBA II",
};

type DraftRow = { key: number; dakoId: string; teacherId: string; assignmentType: string };

/**
 * Master plan §32 — Historical Backfill UI. Records actual pre-go-live
 * Suguan rows through the server workflow (no generation of any kind).
 * Corrections are ADMIN-only with a mandatory reason and keep the row
 * HISTORICAL forever. All validation is re-run server-side.
 */
export function HistoricalClient({
  weekId,
  weekLabel,
  canWrite,
  isAdmin,
  dakos,
  teachers,
  existing,
}: {
  weekId: string;
  weekLabel: string;
  canWrite: boolean;
  isAdmin: boolean;
  dakos: HistoricalDako[];
  teachers: HistoricalTeacher[];
  existing: HistoricalRowExisting[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [correction, setCorrection] = useState<{ row: HistoricalRowExisting; teacherId: string; type: string; reason: string } | null>(null);

  const teacherById = useMemo(() => new Map(teachers.map((t) => [t.id, t])), [teachers]);
  const dakoById = useMemo(() => new Map(dakos.map((d) => [d.id, d])), [dakos]);

  function addRow() {
    setRows((r) => [...r, { key: Date.now() + r.length, dakoId: "", teacherId: "", assignmentType: "SUGO" }]);
  }
  function patchRow(key: number, patch: Partial<DraftRow>) {
    setRows((r) => r.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function record() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await fetch("/api/assignments/historical", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          weekId,
          rows: rows
            .filter((r) => r.dakoId && r.teacherId)
            .map((r) => ({ dakoId: r.dakoId, teacherId: r.teacherId, assignmentType: r.assignmentType })),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMsg({ kind: "error", text: body?.error?.message ?? "recording failed" });
        setConfirming(false);
        return;
      }
      setMsg({ kind: "success", text: `Recorded ${body.data.recorded.length} historical assignment(s). Reloading…` });
      setRows([]);
      setConfirming(false);
      router.refresh();
    });
  }

  function applyCorrection() {
    if (!correction) return;
    if (!correction.reason.trim()) {
      setMsg({ kind: "error", text: "A non-empty reason is required to correct a historical record." });
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/assignments/historical", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assignmentId: correction.row.id,
          teacherId: correction.teacherId || undefined,
          assignmentType: correction.type,
          reason: correction.reason.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMsg({ kind: "error", text: body?.error?.message ?? "correction failed" });
        return;
      }
      setMsg({ kind: "success", text: "Historical record corrected. Reloading…" });
      setCorrection(null);
      router.refresh();
    });
  }

  return (
    <>
      {msg ? <p className={msg.kind === "success" ? "notice" : "error"}>{msg.text}</p> : null}

      {canWrite ? (
        <section className="sched-section">
          <h2>Record historical assignments</h2>
          <p className="info-note">
            Pre-go-live weeks are recorded, never generated — no fairness scoring, no availability
            checks, no master-data changes. Rows are stored with source <strong>HISTORICAL</strong> and
            count toward future fairness. Language eligibility (a Filipino teacher can never serve an
            English dako) is enforced server-side; such rows are rejected, never auto-corrected.
          </p>
          {rows.map((r) => {
            const t = r.teacherId ? teacherById.get(r.teacherId) : null;
            const d = r.dakoId ? dakoById.get(r.dakoId) : null;
            const langMismatch =
              t && d && t.language !== "ENGLISH" && d.language === "ENGLISH";
            return (
              <div key={r.key} className="historical-row">
                <label>
                  Dako
                  <select value={r.dakoId} onChange={(e) => patchRow(r.key, { dakoId: e.target.value })}>
                    <option value="">— select —</option>
                    {dakos.map((d2) => (
                      <option key={d2.id} value={d2.id}>
                        {d2.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Suguan
                  <select value={r.assignmentType} onChange={(e) => patchRow(r.key, { assignmentType: e.target.value })}>
                    {TYPES.map((t2) => (
                      <option key={t2} value={t2}>{TYPE_LABEL[t2]}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Teacher
                  <select value={r.teacherId} onChange={(e) => patchRow(r.key, { teacherId: e.target.value })}>
                    <option value="">— select —</option>
                    {teachers.map((t2) => (
                      <option key={t2.id} value={t2.id}>
                        {t2.fullName} ({t2.teacherCode})
                      </option>
                    ))}
                  </select>
                </label>
                {langMismatch ? <span className="error">LANGUAGE_MISMATCH — will be rejected</span> : null}
                <button type="button" className="btn btn-secondary" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} disabled={pending}>
                  Remove
                </button>
              </div>
            );
          })}
          <div className="actions-row">
            <button type="button" className="btn btn-secondary" onClick={addRow} disabled={pending}>
              Add row
            </button>
            {rows.length > 0 ? (
              <button type="button" className="btn btn-primary" onClick={record} disabled={pending}>
                {confirming ? "Confirm recording" : "Review & record"}
              </button>
            ) : null}
            {confirming ? (
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)} disabled={pending}>
                Cancel
              </button>
            ) : null}
          </div>
          {confirming ? (
            <div className="info-note">
              <strong>Confirm recording for {weekLabel}:</strong>
              <ul>
                {rows.filter((r) => r.dakoId && r.teacherId).map((r) => (
                  <li key={r.key}>
                    {dakoById.get(r.dakoId)?.name} · {TYPE_LABEL[r.assignmentType]} ·{" "}
                    {teacherById.get(r.teacherId)?.fullName}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="sched-section">
        <h2>Recorded historical assignments</h2>
        {existing.length === 0 ? (
          <p className="info-note">Nothing recorded for this week yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dako</th>
                  <th>Suguan</th>
                  <th>Teacher</th>
                  <th>Source</th>
                  {isAdmin ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {existing.map((r) => (
                  <tr key={r.id}>
                    <td>{r.dakoName}</td>
                    <td>{TYPE_LABEL[r.assignmentType] ?? r.assignmentType}</td>
                    <td>{r.teacherName} <span className="info-note">({r.teacherCode})</span></td>
                    <td><span className="badge badge-gray">HISTORICAL</span></td>
                    {isAdmin ? (
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => setCorrection({ row: r, teacherId: r.teacherId, type: r.assignmentType, reason: "" })}
                          disabled={pending}
                        >
                          Correct…
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {correction ? (
        <Modal open onClose={() => setCorrection(null)}>
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Correct historical record">
          <div className="modal">
            <h2>Correct Historical Record</h2>
            <p>
              {correction.row.dakoName} · {TYPE_LABEL[correction.row.assignmentType]} · currently{" "}
              {correction.row.teacherName}.
            </p>
            <p className="info-note">
              The row keeps its HISTORICAL source; the change is audited with a mandatory reason. Master
              data is never modified.
            </p>
            <label>
              Teacher
              <select
                value={correction.teacherId}
                onChange={(e) => setCorrection({ ...correction, teacherId: e.target.value })}
              >
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName} ({t.teacherCode})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Suguan
              <select
                value={correction.type}
                onChange={(e) => setCorrection({ ...correction, type: e.target.value })}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                ))}
              </select>
            </label>
            <label>
              Reason (required, audited)
              <textarea
                rows={3}
                value={correction.reason}
                onChange={(e) => setCorrection({ ...correction, reason: e.target.value })}
              />
            </label>
            {msg?.kind === "error" ? <p className="error">{msg.text}</p> : null}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setCorrection(null)} disabled={pending}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={applyCorrection} disabled={pending}>
                Apply Correction
              </button>
            </div>
          </div>
        </div>
        </Modal>
      ) : null}
    </>
  );
}
