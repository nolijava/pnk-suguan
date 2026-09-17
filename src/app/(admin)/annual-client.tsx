"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnnualSchedule } from "@/lib/annual";

const TYPE_LABEL: Record<string, string> = {
  SUGO: "SUGO",
  RESERBA: "RESERBA",
  RESERBA_II: "RESERBA II",
};

/** §5/§8 — preset reason options for absence / modification workflows. */
const ABSENT_REASON_OPTIONS = ["Sick", "Urgent Matter", "Traffic", "No Info", "Other"];

function weekLabel(w: number): string {
  return `W${String(w).padStart(2, "0")}`;
}

export interface CellAbsentInfo {
  dakoId: string;
  weekId: string;
  weekNumber: number;
  assignmentType: string;
  teacherName: string;
  reason: string;
  actorName: string | null;
  at: string | Date;
}

export interface CellModifiedInfo {
  assignmentId: string;
  originalTeacherName: string | null;
  replacementTeacherName: string | null;
  reason: string | null;
  actorName: string | null;
  at: string | Date;
}

export interface AnnualTablesProps {
  schedule: AnnualSchedule;
  /** `W38` when the selected year is the current ISO year — null otherwise (no false highlight, §4). */
  currentWeekKey: string | null;
  /** Always-shown current ISO week indicator, e.g. `W38 · 2026`. */
  currentIsoLabel: string;
  /** Phase 6 — persisted absence/modification provenance for tooltips (§7/§14). */
  cellInfo: { absentInfo: CellAbsentInfo[]; modifiedInfo: CellModifiedInfo[] };
  /** Whether the current user may open the action prompt (server still enforces). */
  writable: boolean;
}

interface ReplacementCandidate {
  teacherId: string;
  teacherCode: string;
  fullName: string;
  language: string;
}

/** §6/§13 — accessible badges; never color alone. */
function AbsentBadge() {
  return <span className="badge badge-absent">ABSENT</span>;
}
function UpdatedBadge() {
  return <span className="badge badge-updated">[UPDATED]</span>;
}

function fmtDate(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return isNaN(date.getTime()) ? String(d) : date.toLocaleString();
}

/**
 * Phase 5 — the THREE SEPARATE annual tables (SUGO → RESERBA → RESERBA II),
 * vertically stacked, week-aligned via synchronized horizontal scrolling.
 * Dako column is sticky; type and source are conveyed by text, never color
 * alone (§22).
 *
 * Phase 6 — assigned cells are clickable (§2) and open the "What would you
 * like to do?" prompt (Modify / Clear / Cancel). Cancel mutates nothing.
 * Clear and Modify run the §3-§14 server workflows via the Phase 6 APIs.
 * Absence and modification provenance come from persisted audit data (§7/§14).
 */
export function AnnualTables({ schedule, currentWeekKey, currentIsoLabel, cellInfo, writable }: AnnualTablesProps) {
  const router = useRouter();
  const wrapRefs = useRef<(HTMLDivElement | null)[]>([]);
  const syncing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // --- dialog state machine -------------------------------------------------
  type Step =
    | { kind: "none" }
    | { kind: "action"; ctx: StepActionCtx; source: string | null }
    | { kind: "clear-reason"; ctx: StepActionCtx }
    | { kind: "absent-reason"; ctx: StepActionCtx; mode: "clear" | "modify" }
    | { kind: "replacement"; ctx: StepActionCtx; absentReason: string; candidates: ReplacementCandidate[] };

  interface StepActionCtx {
    dakoId: string;
    dakoName: string;
    weekNumber: number;
    type: string;
    assignmentId: string;
    teacherName: string;
    teacherCode: string | null;
  }

  const [step, setStep] = useState<Step>({ kind: "none" });
  const [clearChoice, setClearChoice] = useState<string>("");
  const [reasonChoice, setReasonChoice] = useState<string>("");
  const [customReason, setCustomReason] = useState<string>("");
  const [replacementId, setReplacementId] = useState<string>("");

  const effectiveReason = () => (reasonChoice === "Other" ? customReason.trim() : reasonChoice);

  function closeModal() {
    setStep({ kind: "none" });
    setClearChoice("");
    setReasonChoice("");
    setCustomReason("");
    setReplacementId("");
    setError(null);
  }

  /** §2 — clicking an assigned cell opens the prompt; nothing mutates yet. */
  function openAction(dakoId: string, dakoName: string, weekNumber: number, type: string, cell: { id: string | null; teacherName: string | null; teacherCode: string | null; source: string | null }) {
    if (!writable || !cell.id || !cell.teacherName || busy) return;
    setError(null);
    setStep({
      kind: "action",
      ctx: {
        dakoId,
        dakoName,
        weekNumber,
        type,
        assignmentId: cell.id,
        teacherName: cell.teacherName,
        teacherCode: cell.teacherCode,
      },
      source: cell.source,
    });
  }

  async function loadCandidates(assignmentId: string) {
    const res = await fetch(`/api/assignments/${assignmentId}/eligible-replacements`);
    const json = (await res.json()) as { data?: { rows: ReplacementCandidate[] }; error?: { message: string } };
    if (!res.ok || !json.data) throw new Error(json.error?.message ?? "failed to load eligible replacements");
    return json.data.rows;
  }

  /** §3 → §4 — Clear with reason = Change of Suguan (teacher stays available). */
  async function doClearChangeOfSuguan(ctx: StepActionCtx, reason: string) {
    const res = await fetch(`/api/assignments/${ctx.assignmentId}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearType: "CHANGE_OF_SUGUAN", reason }),
    });
    const json = (await res.json()) as { data?: unknown; error?: { message: string } };
    if (!res.ok) throw new Error(json.error?.message ?? "clear failed");
    return json.data;
  }

  /** §3 → §5 — Clear with reason = Teacher absent in class (marks ABSENT). */
  async function doClearTeacherAbsent(ctx: StepActionCtx, absentReason: string) {
    const res = await fetch(`/api/assignments/${ctx.assignmentId}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearType: "TEACHER_ABSENT", reason: absentReason, absentReason }),
    });
    const json = (await res.json()) as { data?: unknown; error?: { message: string } };
    if (!res.ok) throw new Error(json.error?.message ?? "clear failed");
    return json.data;
  }

  /** §8-§12 — atomic Modify: original ABSENT + replacement assigned. */
  async function doReplace(ctx: StepActionCtx, absentReason: string, replacementTeacherId: string, overrideReason?: string) {
    const res = await fetch(`/api/assignments/${ctx.assignmentId}/replace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replacementTeacherId,
        absentReason,
        ...(overrideReason ? { overrideReason } : {}),
      }),
    });
    const json = (await res.json()) as { data?: unknown; error?: { message: string } };
    if (!res.ok) throw new Error(json.error?.message ?? "replacement failed");
    return json.data;
  }

  // --- keyboard: Escape closes any open dialog (cancel = no mutation) -------
  useEffect(() => {
    if (step.kind === "none") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step.kind]);

  // --- lookup maps for badges/tooltips --------------------------------------
  const absentByKey = useMemo(() => {
    const m = new Map<string, CellAbsentInfo>();
    for (const a of cellInfo.absentInfo) m.set(`${a.dakoId}|${a.weekNumber}|${a.assignmentType}`, a);
    return m;
  }, [cellInfo.absentInfo]);
  const modifiedByAssignment = useMemo(() => {
    const m = new Map<string, CellModifiedInfo>();
    for (const a of cellInfo.modifiedInfo) m.set(a.assignmentId, a);
    return m;
  }, [cellInfo.modifiedInfo]);

  // --- synchronized horizontal scrolling (Phase 5 pattern) ------------------
  // Native listeners (scroll doesn't bubble reliably through React's root
  // delegation in all cases); the syncing guard ALWAYS resets, even if an
  // element detaches mid-scroll (HMR/unmount), so sync can never wedge.
  useEffect(() => {
    const els = wrapRefs.current.filter((e): e is HTMLDivElement => e !== null);
    function onScroll(this: HTMLDivElement) {
      if (syncing.current) return;
      syncing.current = true;
      try {
        for (const el of els) {
          if (el !== this && el.isConnected) el.scrollLeft = this.scrollLeft;
        }
      } finally {
        syncing.current = false;
      }
    }
    els.forEach((el) => el.addEventListener("scroll", onScroll, { passive: true }));
    return () => els.forEach((el) => el.removeEventListener("scroll", onScroll));
  }, [schedule.year]);

  const weeks = Array.from({ length: schedule.weekCount }, (_, i) => i + 1);

  return (
    <section className="annual-section">
      <div className="annual-year-nav">
        <a className="btn btn-secondary" href={`/?year=${schedule.year - 1}`} aria-label={`Previous year ${schedule.year - 1}`}>
          ‹ {schedule.year - 1}
        </a>
        <strong>{schedule.year}</strong>
        <a className="btn btn-secondary" href={`/?year=${schedule.year + 1}`} aria-label={`Next year ${schedule.year + 1}`}>
          {schedule.year + 1} ›
        </a>
        <a className="btn btn-secondary" href="/">Today</a>
        <span className="info-note">Current ISO week: {currentIsoLabel}</span>
      </div>

      {notice ? (
        <p className="success-note" role="status">
          {notice}{" "}
          <button type="button" className="link-btn" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
      ) : null}
      {error && step.kind === "none" ? <p className="error" role="alert">{error}</p> : null}

      {schedule.tables.map((table, ti) => (
        <div key={table.assignmentType} className="annual-block">
          <h2>
            {TYPE_LABEL[table.assignmentType]} — {schedule.year}
          </h2>
          <div
            className="annual-scroll"
            ref={(el) => {
              wrapRefs.current[ti] = el;
            }}
            tabIndex={0}
            role="region"
            aria-label={`${TYPE_LABEL[table.assignmentType]} annual schedule ${schedule.year}`}
          >
            <table className="annual-table">
              <caption className="info-note">
                {TYPE_LABEL[table.assignmentType]} · {schedule.year} · Dako × ISO week ({schedule.weekCount} weeks)
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="dako-col">Dako</th>
                  {weeks.map((w) => (
                    <th key={w} scope="col" className={currentWeekKey === weekLabel(w) ? "current-week" : undefined}>
                      {weekLabel(w)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.dakoRows.length === 0 ? (
                  <tr>
                    <td colSpan={schedule.weekCount + 1}>No dakos with schedule data for {schedule.year}.</td>
                  </tr>
                ) : (
                  table.dakoRows.map((d) => (
                    <tr key={d.dakoId}>
                      <th scope="row" className="dako-col">
                        {d.dakoName}
                        {d.disabled ? <span className="badge badge-gray">DISABLED</span> : null}
                      </th>
                      {d.cells.map((c, i) => {
                        const absent = absentByKey.get(`${d.dakoId}|${i + 1}|${table.assignmentType}`);
                        const modified = modifiedByAssignment.get(c.id ?? "");
                        return (
                          <td key={i} className={currentWeekKey === weekLabel(i + 1) ? "current-week" : undefined}>
                            {c.teacherName ? (
                              writable ? (
                                <button
                                  type="button"
                                  className="cell-btn"
                                  onClick={() =>
                                    openAction(d.dakoId, d.dakoName, i + 1, table.assignmentType, c)
                                  }
                                  aria-haspopup="dialog"
                                >
                                  <span>{c.teacherName}</span>
                                  {c.source && c.source !== "AUTO" ? <span className="badge badge-gray">{c.source}</span> : null}
                                  {modified ? <UpdatedBadge /> : null}
                                  {absent ? <AbsentBadge /> : null}
                                  {absent || modified ? (
                                    <span className="cell-info" role="note">
                                      {absent
                                        ? `${absent.teacherName} — ABSENT · Reason: ${absent.reason} · Week: ${weekLabel(i + 1)} · ${TYPE_LABEL[table.assignmentType]} · Recorded by: ${absent.actorName ?? "unknown"} · At: ${fmtDate(absent.at)}`
                                        : modified
                                          ? `Assignment Updated — ${modified.originalTeacherName ?? "The original teacher"} was absent${modified.reason ? ` (${modified.reason})` : ""}. Replacement: ${c.teacherName} · Week: ${weekLabel(i + 1)} · Updated by: ${modified.actorName ?? "unknown"} · At: ${fmtDate(modified.at)}`
                                          : ""}
                                    </span>
                                  ) : null}
                                </button>
                              ) : (
                                <span className="cell-static" tabIndex={0}>
                                  <span>{c.teacherName}</span>
                                  {c.source && c.source !== "AUTO" ? <span className="badge badge-gray">{c.source}</span> : null}
                                  {modified ? <UpdatedBadge /> : null}
                                  {absent ? <AbsentBadge /> : null}
                                  {absent || modified ? (
                                    <span className="cell-info" role="note">
                                      {absent
                                        ? `${absent.teacherName} — ABSENT · Reason: ${absent.reason} · Week: ${weekLabel(i + 1)} · ${TYPE_LABEL[table.assignmentType]} · Recorded by: ${absent.actorName ?? "unknown"} · At: ${fmtDate(absent.at)}`
                                        : modified
                                          ? `Assignment Updated — ${modified.originalTeacherName ?? "The original teacher"} was absent${modified.reason ? ` (${modified.reason})` : ""}. Replacement: ${c.teacherName} · Week: ${weekLabel(i + 1)} · Updated by: ${modified.actorName ?? "unknown"} · At: ${fmtDate(modified.at)}`
                                          : ""}
                                    </span>
                                  ) : null}
                                </span>
                              )
                            ) : absent ? (
                              /* §6/§7 — cell emptied by a teacher-absent clear must
                                 still visibly indicate the absence, from persisted
                                 audit data (not color alone, hover AND focus). */
                              <span className="cell-static" tabIndex={0}>
                                <span className="info-note">{absent.teacherName}</span>
                                <AbsentBadge />
                                <span className="cell-info" role="note">
                                  {`${absent.teacherName} — ABSENT · Reason: ${absent.reason} · Week: ${weekLabel(i + 1)} · ${TYPE_LABEL[table.assignmentType]} · Recorded by: ${absent.actorName ?? "unknown"} · At: ${fmtDate(absent.at)}`}
                                </span>
                              </span>
                            ) : (
                              <span className="info-note">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* ---------------- dialogs ---------------- */}
      {step.kind === "action" ? (
        <div className="modal-backdrop" role="presentation" onClick={closeModal}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="cell-action-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="cell-action-title">What would you like to do?</h3>
            <p>
              <strong>{step.ctx.teacherName}</strong> — {TYPE_LABEL[step.ctx.type]} · {weekLabel(step.ctx.weekNumber)} · {step.ctx.dakoName}
              {step.source && step.source !== "AUTO" ? <> · <span className="badge badge-gray">{step.source}</span></> : null}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setClearChoice(""); setStep({ kind: "clear-reason", ctx: step.ctx }); }}>
                Clear
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setReasonChoice(""); setCustomReason(""); setStep({ kind: "absent-reason", ctx: step.ctx, mode: "modify" }); }}>
                Modify
              </button>
              <button type="button" className="btn btn-secondary" onClick={closeModal}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {step.kind === "clear-reason" ? (
        <div className="modal-backdrop" role="presentation" onClick={closeModal}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="clear-reason-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="clear-reason-title">Reason required</h3>
            <p className="info-note">
              {step.ctx.teacherName} — {TYPE_LABEL[step.ctx.type]} · {weekLabel(step.ctx.weekNumber)} · {step.ctx.dakoName}
            </p>
            <fieldset>
              <legend>Why is this assignment being cleared?</legend>
              {["Change of Suguan", "Teacher is absent in Class"].map((opt) => (
                <label key={opt} className="radio-row">
                  <input
                    type="radio"
                    name="clear-reason"
                    value={opt}
                    checked={clearChoice === opt}
                    onChange={() => setClearChoice(opt)}
                  />{" "}
                  {opt}
                </label>
              ))}
            </fieldset>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !clearChoice}
                onClick={() => {
                  if (clearChoice === "Change of Suguan") {
                    // §4 — committed immediately after this confirmation click.
                    setBusy(true);
                    doClearChangeOfSuguan(step.ctx, clearChoice)
                      .then(() => {
                        setNotice(`Assignment cleared (${clearChoice}) — ${step.ctx.teacherName} remains available for another eligible suguan this week.`);
                        closeModal();
                        router.refresh();
                      })
                      .catch((e: unknown) => {
                        setError(e instanceof Error ? e.message : "clear failed");
                        closeModal();
                      })
                      .finally(() => setBusy(false));
                  } else {
                    setReasonChoice("");
                    setCustomReason("");
                    setStep({ kind: "absent-reason", ctx: step.ctx, mode: "clear" });
                  }
                }}
              >
                Continue
              </button>
              <button type="button" className="btn btn-secondary" onClick={closeModal}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {step.kind === "absent-reason" ? (
        <div className="modal-backdrop" role="presentation" onClick={closeModal}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="absent-reason-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="absent-reason-title">{step.mode === "clear" ? "Absence reason" : "Unable to attend class due to:"}</h3>
            <p className="info-note">
              {step.ctx.teacherName} — {TYPE_LABEL[step.ctx.type]} · {weekLabel(step.ctx.weekNumber)} · {step.ctx.dakoName}
            </p>
            <fieldset>
              <legend>Reason</legend>
              {ABSENT_REASON_OPTIONS.map((opt) => (
                <label key={opt} className="radio-row">
                  <input
                    type="radio"
                    name="absent-reason"
                    value={opt}
                    checked={reasonChoice === opt}
                    onChange={() => setReasonChoice(opt)}
                  />{" "}
                  {opt}
                </label>
              ))}
              {reasonChoice === "Other" ? (
                <label className="stack">
                  <span>Please specify the reason</span>
                  <input
                    type="text"
                    value={customReason}
                    onChange={(e) => setCustomReason(e.target.value)}
                    required
                    aria-required="true"
                  />
                </label>
              ) : null}
            </fieldset>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !effectiveReason()}
                onClick={async () => {
                  const reason = effectiveReason();
                  if (step.mode === "clear") {
                    // §5 — TEACHER_ABSENT clear commits here (§36: absence ≠ change of suguan).
                    setBusy(true);
                    try {
                      await doClearTeacherAbsent(step.ctx, reason);
                      setNotice(`Assignment cleared — ${step.ctx.teacherName} marked ABSENT for ${weekLabel(step.ctx.weekNumber)} (${TYPE_LABEL[step.ctx.type]}); excluded from next week's automatic generation.`);
                      closeModal();
                      router.refresh();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "clear failed");
                      closeModal();
                    } finally {
                      setBusy(false);
                    }
                  } else {
                    // §8-§10 — load the SERVER-SIDE eligible replacement list.
                    setBusy(true);
                    try {
                      const rows = await loadCandidates(step.ctx.assignmentId);
                      setReplacementId("");
                      setStep({ kind: "replacement", ctx: step.ctx, absentReason: reason, candidates: rows });
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "failed to load replacements");
                      closeModal();
                    } finally {
                      setBusy(false);
                    }
                  }
                }}
              >
                Continue
              </button>
              <button type="button" className="btn btn-secondary" onClick={closeModal}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {step.kind === "replacement" ? (
        <div className="modal-backdrop" role="presentation" onClick={closeModal}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="replacement-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="replacement-title">Select replacement teacher</h3>
            <p className="info-note">
              {step.ctx.teacherName} was absent due to: <strong>{step.absentReason}</strong> — {TYPE_LABEL[step.ctx.type]} ·{" "}
              {weekLabel(step.ctx.weekNumber)} · {step.ctx.dakoName}
            </p>
            {step.candidates.length === 0 ? (
              <p className="info-note">No eligible replacement teachers (server-side eligibility returned an empty list).</p>
            ) : (
              <fieldset>
                <legend>Eligible teachers (server-side eligibility)</legend>
                {step.candidates.map((t) => (
                  <label key={t.teacherId} className="radio-row">
                    <input
                      type="radio"
                      name="replacement"
                      value={t.teacherId}
                      checked={replacementId === t.teacherId}
                      onChange={() => setReplacementId(t.teacherId)}
                    />{" "}
                    {t.fullName} <span className="info-note">({t.teacherCode} · {t.language})</span>
                  </label>
                ))}
              </fieldset>
            )}
            <p className="info-note">
              Confirming will mark <strong>{step.ctx.teacherName}</strong> ABSENT for {weekLabel(step.ctx.weekNumber)} and assign the selected teacher (source OVERRIDE where rules are bypassed by an administrator).
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !replacementId}
                onClick={async () => {
                  const t = step.candidates.find((x) => x.teacherId === replacementId);
                  setBusy(true);
                  try {
                    await doReplace(step.ctx, step.absentReason, replacementId);
                    setNotice(
                      `Assignment updated — ${step.ctx.teacherName} marked ABSENT (${step.absentReason}); ${t?.fullName ?? "replacement"} assigned to ${TYPE_LABEL[step.ctx.type]} · ${weekLabel(step.ctx.weekNumber)} · ${step.ctx.dakoName}.`,
                    );
                    closeModal();
                    router.refresh();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "replacement failed");
                    closeModal();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Confirm Assignment
              </button>
              <button type="button" className="btn btn-secondary" onClick={closeModal}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
