"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
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
  weekYear: number;
  weekNumber: number;
  weekStatus: "DRAFT" | "FINALIZED" | "PUBLISHED";
  canWrite: boolean;
  canGenerate: boolean;
  canFinalize: boolean;
  canPublish: boolean;
  /** Phase 7 — operator-only print-ready PDF of the physical Suguan form. */
  canPdf: boolean;
  absenceCount: number;
  rows: SlotRow[];
  summary: { dakos: number; sugoAssigned: number; reserbaAssigned: number; reserbaIiAssigned: number; unassigned: number } | null;
}

const TYPE_LABEL: Record<string, string> = {
  SUGO: "SUGO",
  RESERBA: "RESERBA",
  RESERBA_II: "RESERBA II",
};

/** Human-readable violated-rule text (§22 informational; server is authoritative). */
const RULE_LABEL: Record<string, string> = {
  TEACHER_INACTIVE_MASTER: "Teacher is INACTIVE (master data)",
  DAKO_DISABLED: "Dako is DISABLED",
  WEEKLY_ABSENT: "Absent this week",
  WEEKLY_INACTIVE: "Weekly availability INACTIVE",
  NOT_ENCODED: "Availability not encoded",
  PREVIOUS_WEEK_ABSENT: "Absent last week (hard automatic exclusion)",
  ALREADY_ASSIGNED_THIS_WEEK: "Already assigned this week",
  LANGUAGE_MISMATCH: "Language mismatch — never overridable",
};

/** Mirror of NON_OVERRIDEABLE_RULES (src/lib/eligibility.ts) for UX only. */
const NON_OVERRIDEABLE: readonly string[] = ["DAKO_DISABLED", "LANGUAGE_MISMATCH"];

interface CandidateTeacher {
  teacherId: string;
  teacherCode: string;
  fullName: string;
  language: string;
}
interface UnavailableTeacher extends CandidateTeacher {
  violatedRules: string[];
  overrideAllowed: boolean;
}
interface SlotCandidates {
  slot: { dakoId: string; assignmentType: string };
  eligible: CandidateTeacher[];
  unavailable: UnavailableTeacher[];
}

/**
 * §6 pre-generation warning flow: Generate → fresh server absence count →
 * confirm dialog when N > 0 → POST /api/scheduling/generate.
 *
 * §19 Delegate (empty slot): eligible-only selector, no reason, confirmation
 * shows Week/Dako/Type/Teacher/Source, POST → assignment_source=MANUAL.
 *
 * §20 Override (existing assignment): eligible-only selector + mandatory
 * audited reason, confirmation shows current+replacement+reason, PATCH.
 *
 * §21 ADMIN exception mode (separate explicit toggle, normal dropdown stays
 * eligible-only): unavailable candidates listed WITH their violated rule;
 * non-overrideable rules are refused outright even here. The server
 * re-validates everything — the UI never grants the bypass.
 *
 * §22 View Unavailable Teachers: informational panel, selection disabled.
 */
export function ScheduleActions({
  weekId,
  weekYear,
  weekNumber,
  weekStatus,
  canWrite,
  canGenerate,
  canFinalize,
  canPublish,
  canPdf,
  absenceCount,
  rows,
  summary,
}: ScheduleActionsProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [showAbsentWarning, setShowAbsentWarning] = useState(false);
  const [freshCount, setFreshCount] = useState(0);

  // Shared slot-assignment dialog state (§19/§20/§21).
  const [slot, setSlot] = useState<{ row: SlotRow; mode: "delegate" | "override" } | null>(null);
  const [candidates, setCandidates] = useState<SlotCandidates | null>(null);
  const [candidatesErr, setCandidatesErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exceptionMode, setExceptionMode] = useState(false); // ADMIN-only explicit opt-in
  const [review, setReview] = useState(false);
  const [reason, setReason] = useState("");
  const [slotErr, setSlotErr] = useState<string | null>(null);

  const [showUnavailable, setShowUnavailable] = useState(false);
  const [unavailable, setUnavailable] = useState<UnavailableTeacher[] | null>(null);
  const [unavailableErr, setUnavailableErr] = useState<string | null>(null);

  const isAdmin = canFinalize && canPublish; // finalize+publish ⇒ ADMIN
  const locked = weekStatus !== "DRAFT";

  // §23 — FINALIZED stays correctable through the authorized correction
  // workflow: when an active correction grant is held for this week, cell
  // actions light up (server re-validates via assertScheduleCorrectable).
  // Generation stays DRAFT-only regardless.
  const [correctionActive, setCorrectionActive] = useState(false);
  useEffect(() => {
    if (weekStatus === "DRAFT") return;
    let alive = true;
    fetch(`/api/weeks/${weekId}/correction`)
      .then((r) => r.json())
      .then((b) => {
        if (alive && b?.data?.active) setCorrectionActive(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [weekId, weekStatus]);

  const editable = canWrite && (!locked || correctionActive);

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

  // -------------------------------------------------------------------------
  // §19/§20/§21 slot dialogs
  // -------------------------------------------------------------------------

  const fetchCandidates = useCallback(
    async (row: SlotRow, mode: "delegate" | "override"): Promise<SlotCandidates | null> => {
      const params = new URLSearchParams({
        weekId,
        dakoId: row.dakoId,
        assignmentType: row.assignmentType,
      });
      if (mode === "override" && row.id) params.set("assignmentId", row.id);
      const res = await fetch(`/api/scheduling/slot-candidates?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) {
        setCandidatesErr(body?.error?.message ?? "failed to load eligible teachers");
        return null;
      }
      return body.data as SlotCandidates;
    },
    [weekId],
  );

  function openSlotDialog(row: SlotRow, mode: "delegate" | "override") {
    setSlot({ row, mode });
    setCandidates(null);
    setCandidatesErr(null);
    setSearch("");
    setSelectedId(null);
    setExceptionMode(false);
    setReview(false);
    setReason("");
    setSlotErr(null);
    startTransition(async () => {
      const data = await fetchCandidates(row, mode);
      if (data) setCandidates(data);
    });
  }

  function closeSlotDialog() {
    setSlot(null);
    setCandidates(null);
    setReview(false);
  }

  const selectedTeacher = useMemo(() => {
    if (!candidates || !selectedId) return null;
    return (
      candidates.eligible.find((t) => t.teacherId === selectedId) ??
      candidates.unavailable.find((t) => t.teacherId === selectedId) ??
      null
    );
  }, [candidates, selectedId]);

  const selectedIsException = useMemo(() => {
    if (!candidates || !selectedId) return false;
    return !candidates.eligible.some((t) => t.teacherId === selectedId);
  }, [candidates, selectedId]);

  const filteredEligible = useMemo(() => {
    if (!candidates) return [];
    const q = search.trim().toLowerCase();
    if (!q) return candidates.eligible;
    return candidates.eligible.filter((t) => t.fullName.toLowerCase().includes(q));
  }, [candidates, search]);

  /** §21 — exception mode: refetch and expose the unavailable list with rules. */
  function toggleExceptionMode() {
    if (!slot) return;
    const next = !exceptionMode;
    setExceptionMode(next);
    setSelectedId(null);
    setReview(false);
    setSlotErr(null);
    if (next && candidates) return; // unavailable list already loaded
    if (next) {
      startTransition(async () => {
        const data = await fetchCandidates(slot.row, slot.mode);
        if (data) setCandidates(data);
      });
    }
  }

  function proceedToReview() {
    if (!slot || !selectedTeacher) {
      setSlotErr("Select a teacher first.");
      return;
    }
    if (slot.mode === "override" && !reason.trim()) {
      setSlotErr("A non-empty reason is required for an override.");
      return;
    }
    if (selectedIsException && !exceptionMode) {
      setSlotErr("This teacher is not eligible — enable exception mode to continue.");
      return;
    }
    if (selectedIsException && !selectedTeacherViolatesNonOverrideable) {
      // §21 — non-overrideable rules never reach here; other violations require
      // the explicit exception acknowledgement (reason) before confirmation.
    }
    setSlotErr(null);
    setReview(true);
  }

  const selectedTeacherViolatesNonOverrideable = useMemo(() => {
    if (!selectedIsException || !selectedTeacher) return false;
    const u = selectedTeacher as UnavailableTeacher;
    return u.violatedRules.some((r) => NON_OVERRIDEABLE.includes(r));
  }, [selectedIsException, selectedTeacher]);

  function applySlot() {
    if (!slot || !selectedTeacher) return;
    if (slot.mode === "override" && !reason.trim()) {
      setSlotErr("A non-empty reason is required for an override.");
      return;
    }
    setMessage(null);
    startTransition(async () => {
      try {
        const res =
          slot.mode === "override" && slot.row.id
            ? await fetch(`/api/assignments/${slot.row.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ teacherId: selectedTeacher.teacherId, reason: reason.trim() }),
              })
            : await fetch("/api/assignments", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  weekId,
                  dakoId: slot.row.dakoId,
                  assignmentType: slot.row.assignmentType,
                  teacherId: selectedTeacher.teacherId,
                  // Delegate = MANUAL (no reason). ADMIN exception on an empty
                  // slot carries the mandatory audited reason → OVERRIDE source.
                  overrideReason: reason.trim() || undefined,
                }),
              });
        const body = await res.json();
        if (!res.ok) {
          setSlotErr(body?.error?.message ?? "assignment failed");
          setReview(false);
          return;
        }
        closeSlotDialog();
        setMessage({ kind: "success", text: "Assignment saved. Reloading…" });
        window.location.reload();
      } catch {
        setSlotErr("network error — assignment not saved");
        setReview(false);
      }
    });
  }

  // §22 — informational only.
  function openUnavailable() {
    setShowUnavailable(true);
    setUnavailable(null);
    setUnavailableErr(null);
    const first = rows[0];
    if (!first) {
      setUnavailableErr("No slots available for this week.");
      return;
    }
    startTransition(async () => {
      const params = new URLSearchParams({
        weekId,
        dakoId: first.dakoId,
        assignmentType: first.assignmentType,
      });
      const res = await fetch(`/api/scheduling/slot-candidates?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) setUnavailableErr(body?.error?.message ?? "failed to load availability information");
      else setUnavailable((body.data as SlotCandidates).unavailable);
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
          {editable ? (
              <button type="button" className="btn btn-secondary" onClick={openUnavailable} disabled={pending}>
                View Unavailable Teachers
              </button>
          ) : null}
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
          {canPdf ? (
            /* Phase 7 — read-only physical-form PDF for the selected week;
               opens in a new tab for native print/save. Server enforces RBAC. */
            <a
              className="btn btn-secondary"
              href={`/api/schedule/weekly-suguan-pdf?year=${weekYear}&week=${weekNumber}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Generate Weekly Suguan PDF
            </a>
          ) : null}
        </div>
      </div>

      {message ? <p className={message.kind === "success" ? "notice" : "error"}>{message.text}</p> : null}
      {locked || correctionActive ? (
        <p className="info-note">
          {weekStatus === "PUBLISHED"
            ? correctionActive
              ? "PUBLISHED — SUPER_ADMIN correction window active; changes are audited. The week remains PUBLISHED."
              : "PUBLISHED — this schedule is immutable. Corrections require the authorized correction workflow."
            : correctionActive
              ? "FINALIZED — authorized correction window active; changes are audited. Generation stays locked."
              : "FINALIZED — generation is locked; authorized corrections may still be applied."}
        </p>
      ) : null}

      {/* §31 — THREE SEPARATE sections: SUGO / RESERBA / RESERBA II. Never one merged table. */}
      {["SUGO", "RESERBA", "RESERBA_II"].map((type) => {
        const sectionRows = rows.filter((r) => r.assignmentType === type);
        return (
          <section key={type} className="sched-section">
            <h2>{TYPE_LABEL[type] ?? type}</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Dako</th>
                    <th>Teacher</th>
                    <th>Source</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sectionRows.length === 0 ? (
                    <tr><td colSpan={5}>No {TYPE_LABEL[type] ?? type} slots for this week.</td></tr>
                  ) : (
                    sectionRows.map((r, i) => (
                      <tr key={`${r.dakoCode}|${r.assignmentType}|${i}`} className={r.occupiedByManual ? "row-manual" : ""}>
                        {/* Phase 6 §1 — Dako Code hidden from schedule display; name only. */}
                        <td>{r.dakoName}</td>
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
                          {editable ? (
                            r.id ? (
                              <button type="button" className="btn btn-secondary" onClick={() => openSlotDialog(r, "override")}>
                                Override…
                              </button>
                            ) : (
                              <button type="button" className="btn btn-secondary" onClick={() => openSlotDialog(r, "delegate")}>
                                Delegate…
                              </button>
                            )
                          ) : null}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

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

      {slot ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={slot.mode === "delegate" ? "Manual Assignment" : "Manual Assignment Override"}>
          <div className="modal">
            <h2>{slot.mode === "delegate" ? "Manual Assignment" : "Manual Assignment Override"}</h2>
            <p>
              {slot.mode === "delegate" ? "Delegating" : "Overriding"} the <strong>{slot.row.assignmentType}</strong> slot of{" "}
              <strong>{slot.row.dakoName}</strong>
              {slot.mode === "override" && slot.row.teacherName ? (
                <> (currently: {slot.row.teacherName})</>
              ) : null}
              .
            </p>

            {!review ? (
              <>
                <p className="info-note">
                  Eligible teachers only — computed server-side from the same rules the scheduling engine uses.
                  {isAdmin ? " Exception mode (ADMIN) lists ineligible candidates with their violated rule." : ""}
                </p>
                {candidatesErr ? <p className="error">{candidatesErr}</p> : null}
                {candidates ? (
                  candidates.eligible.length === 0 ? (
                    <p className="info-note">
                      No eligible teachers for this slot.{" "}
                      {isAdmin ? "Enable exception mode to review ineligible candidates." : "Generate or adjust availability first."}
                    </p>
                  ) : null
                ) : null}

                {isAdmin ? (
                  <label className="exception-toggle">
                    <input
                      type="checkbox"
                      checked={exceptionMode}
                      onChange={toggleExceptionMode}
                      disabled={pending}
                    />
                    {" "}Exception mode (ADMIN) — show ineligible teachers with their violated rule
                  </label>
                ) : null}

                <label>
                  Search teacher by name
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Type a name…"
                    disabled={pending}
                  />
                </label>

                <div className="candidate-list" role="radiogroup" aria-label="Replacement teacher">
                  {candidates === null ? (
                    <p className="info-note">Loading teachers…</p>
                  ) : (
                    <>
                      {filteredEligible.map((t) => (
                        <label key={t.teacherId} className={`candidate ${selectedId === t.teacherId ? "candidate-selected" : ""}`}>
                          <input
                            type="radio"
                            name="replacement-teacher"
                            value={t.teacherId}
                            checked={selectedId === t.teacherId}
                            onChange={() => { setSelectedId(t.teacherId); setReview(false); setSlotErr(null); }}
                            disabled={pending}
                          />
                          <span>{t.fullName}</span>
                          <span className="info-note">
                            {t.language} · {t.teacherCode}
                          </span>
                        </label>
                      ))}

                      {exceptionMode
                        ? candidates.unavailable
                            .filter((t) => !search.trim() || t.fullName.toLowerCase().includes(search.trim().toLowerCase()))
                            .map((t) => {
                              const blocked = t.violatedRules.some((r) => NON_OVERRIDEABLE.includes(r));
                              return (
                                <label
                                  key={t.teacherId}
                                  className={`candidate candidate-exception ${blocked ? "candidate-blocked" : ""} ${selectedId === t.teacherId ? "candidate-selected" : ""}`}
                                >
                                  <input
                                    type="radio"
                                    name="replacement-teacher"
                                    value={t.teacherId}
                                    checked={selectedId === t.teacherId}
                                    onChange={() => {
                                      if (blocked) return; // §21 — never selectable, even in exception mode
                                      setSelectedId(t.teacherId);
                                      setReview(false);
                                      setSlotErr(null);
                                    }}
                                    disabled={pending || blocked}
                                    aria-disabled={blocked}
                                  />
                                  <span>{t.fullName}</span>
                                  <span className={blocked ? "error" : "info-note"}>
                                    {blocked ? "NOT ALLOWABLE: " : ""}
                                    {t.violatedRules.map((r) => RULE_LABEL[r] ?? r).join("; ")}
                                  </span>
                                </label>
                              );
                            })
                        : null}
                    </>
                  )}
                </div>

                {selectedTeacher && selectedIsException ? (
                  <div className="error" role="alert">
                    <strong>
                      {selectedTeacherViolatesNonOverrideable
                        ? "Cannot be assigned: this candidate violates a rule that no override can bypass (LANGUAGE_MISMATCH on an English dako is fixed only by changing the teacher's profile language to ENGLISH; a DISABLED dako cannot receive assignments)."
                        : `Exception candidate — violates: ${(selectedTeacher as UnavailableTeacher).violatedRules.map((r) => RULE_LABEL[r] ?? r).join(", ")}`}
                    </strong>
                    {!selectedTeacherViolatesNonOverrideable ? (
                      <div className="info-note">
                        Continuing requires an administrator override reason and produces an OVERRIDE-source assignment.
                        The server re-validates everything — teacher/dako master data, availability, and Current
                        Destination are never modified.
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {slot.mode === "override" || exceptionMode ? (
                  <label>
                    Reason (required, audited)
                    <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} />
                  </label>
                ) : null}

                {slotErr ? <p className="error">{slotErr}</p> : null}

                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={closeSlotDialog} disabled={pending}>Cancel</button>
                  <button type="button" className="btn btn-primary" onClick={proceedToReview} disabled={pending || !candidates}>
                    Review Changes
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>Confirm {slot.mode === "delegate" ? "Assignment" : "Override"}</h3>
                <table className="confirm-table">
                  <tbody>
                    <tr><th scope="row">Week</th><td>W{String(weekNumber).padStart(2, "0")} · {weekYear}</td></tr>
                    <tr><th scope="row">Dako</th><td>{slot.row.dakoName}</td></tr>
                    <tr><th scope="row">Suguan</th><td>{TYPE_LABEL[slot.row.assignmentType] ?? slot.row.assignmentType}</td></tr>
                    {slot.mode === "override" && slot.row.teacherName ? (
                      <tr><th scope="row">Current teacher</th><td>{slot.row.teacherName}</td></tr>
                    ) : null}
                    <tr><th scope="row">{slot.mode === "delegate" ? "Teacher" : "Replacement teacher"}</th><td>{selectedTeacher?.fullName}</td></tr>
                    {selectedIsException ? (
                      <tr>
                        <th scope="row">Exception</th>
                        <td className="error">
                          {(selectedTeacher as UnavailableTeacher).violatedRules.map((r) => RULE_LABEL[r] ?? r).join(", ")}
                        </td>
                      </tr>
                    ) : null}
                    {slot.mode === "override" || (exceptionMode && selectedIsException) ? (
                      <tr><th scope="row">Reason</th><td>{reason.trim()}</td></tr>
                    ) : null}
                    <tr>
                      <th scope="row">Source</th>
                      <td>{selectedIsException ? "OVERRIDE" : slot.mode === "delegate" ? "MANUAL" : "OVERRIDE"}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="info-note">
                  Validated fresh server-side on confirm. Teacher/dako master data, availability, and Current
                  Destination are never modified by this operation.
                </p>
                {slotErr ? <p className="error">{slotErr}</p> : null}
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setReview(false)} disabled={pending}>Back</button>
                  <button type="button" className="btn btn-secondary" onClick={closeSlotDialog} disabled={pending}>Cancel</button>
                  <button type="button" className="btn btn-primary" onClick={applySlot} disabled={pending}>
                    {slot.mode === "delegate" && !selectedIsException ? "Assign" : "Confirm Override"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {showUnavailable ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Unavailable teachers">
          <div className="modal">
            <h2>View Unavailable Teachers</h2>
            <p className="info-note">
              Informational only — these teachers cannot be selected for assignment this week.
            </p>
            {unavailableErr ? <p className="error">{unavailableErr}</p> : null}
            {unavailable === null ? (
              <p className="info-note">Loading…</p>
            ) : unavailable.length === 0 ? (
              <p className="notice">Every teacher is eligible this week.</p>
            ) : (
              <ul className="unavailable-list">
                {unavailable.map((t) => (
                  <li key={t.teacherId}>
                    <strong>{t.fullName}</strong>
                    <span className="info-note">
                      {" "}— {t.violatedRules.map((r) => RULE_LABEL[r] ?? r).join("; ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowUnavailable(false)} disabled={pending}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
