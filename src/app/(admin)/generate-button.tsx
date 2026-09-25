"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./_components/modal";
import { isoWeeksInYear } from "@/lib/iso-week";

type GenerateMode = "auto" | "manual" | "destinado" | "katuwang";

const MODE_LABEL: Record<GenerateMode, string> = {
  auto: "Auto-generate",
  manual: "Manual",
  destinado: "Assign Destinado",
  katuwang: "Assign Katuwang",
};

const MODES: GenerateMode[] = ["auto", "manual", "destinado", "katuwang"];

/**
 * Update #19/#22 — dashboard "Generate Suguan" entry point: ONE modal carrying
 * TWO inputs — the ISO WEEK to generate and the Generation Method. Both are
 * submitted together on Confirm (Update #9: Confirm is the ONLY confirmation
 * step; no second dialog is ever stacked on top of this modal).
 *
 *  - ISO WEEK — Week 1 … Week 52/53 of the dashboard's ISO year (Week 53 only
 *    when that year has one). The selected week is the week that will be
 *    generated; the ISO year is preserved exactly.
 *  - Auto-generate → runs the EXISTING scheduling engine (/api/scheduling/
 *    generate — same flow the weekly page owns: DRAFT lifecycle, regeneration
 *    rules, hard exclusions) for the SELECTED week and LEAVES THE WEEK IN DRAFT.
 *  - Manual → the server gate validates the selected week and only then opens
 *    the weekly scheduling interface for hand encoding.
 *  - Assign Destinado / Assign Katuwang → Guro-Duty generation modes, enforced
 *    server-side from each teacher's stored Duty; same DRAFT lifecycle and hard
 *    eligibility rules.
 *
 * Update #22 — WEEKLY AVAILABILITY PREREQUISITE. Confirm validates the SELECTED
 * week's availability on the server (authoritative, audited) BEFORE anything is
 * generated or persisted. When required availability is missing the modal stays
 * open and shows the "Weekly Availability Required" notice with a direct
 * "Go to Weekly Availability" action — the operator's confirmation never
 * bypasses the rule.
 */
export function GenerateSuguanButton({ currentYear, currentWeek }: { currentYear: number; currentWeek: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [week, setWeek] = useState(currentWeek);
  const [mode, setMode] = useState<GenerateMode>("auto");
  const [blocked, setBlocked] = useState<{ message: string; year: number; week: number } | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);
  // Real request/navigation state only — the button reflects the actual transition.
  const [busy, startBusy] = useTransition();

  const weeksInYear = isoWeeksInYear(currentYear);
  const weekOptions = Array.from({ length: weeksInYear }, (_, i) => i + 1);

  function confirm() {
    setMessage(null);
    setBlocked(null);
    const targetWeek = week;
    const targetMode = mode;
    startBusy(async () => {
      try {
        const res = await fetch("/api/scheduling/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ year: currentYear, week: targetWeek, mode: targetMode }),
        });
        const body = await res.json();
        if (!res.ok) {
          const err = body?.error as { code?: string; message?: string } | undefined;
          // Update #22 — availability prerequisite: keep the modal open and show
          // the blocking notice with its Weekly Availability action.
          if (err?.code === "AVAILABILITY_REQUIRED") {
            setBlocked({
              message:
                err.message ??
                `Weekly Availability has not been set for one or more teachers for ISO Week ${targetWeek}, ${currentYear}. Please set the teacher availability before generating the Suguan.`,
              year: currentYear,
              week: targetWeek,
            });
            return;
          }
          setOpen(false);
          setMessage({ kind: "error", text: err?.message ?? "generation failed" });
          return;
        }
        if (targetMode === "manual") {
          // The gate passed — open the weekly scheduling interface for the
          // SELECTED week (never the browser's week).
          setOpen(false);
          router.push(`/schedule?year=${currentYear}&week=${targetWeek}`);
          return;
        }
        const data = body.data as { inserted: number; regenerated: boolean };
        setOpen(false);
        const wk = `ISO W${String(targetWeek).padStart(2, "0")} · ${currentYear}`;
        setMessage({
          kind: "success",
          text:
            targetMode === "auto"
              ? `${data.regenerated ? "Regenerated" : "Generated"} ${data.inserted} assignment(s) for ${wk} — the week remains DRAFT.`
              : `${MODE_LABEL[targetMode]}: ${data.regenerated ? "re-" : ""}assigned ${data.inserted} slot(s) for ${wk} — the week remains DRAFT.`,
        });
        router.refresh();
      } catch {
        setOpen(false);
        setMessage({ kind: "error", text: "network error — generation not executed" });
      }
    });
  }

  return (
    <div className="generate-suguan">
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          setMessage(null);
          setBlocked(null);
          setOpen(true);
        }}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        {busy ? "Working…" : "Generate Suguan"}
      </button>
      {message ? (
        <p
          className={message.kind === "success" ? "success-note" : message.kind === "error" ? "error-note" : "info-note"}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
      {open ? (
        <Modal open onClose={() => setOpen(false)}>
        <div className="modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="generate-suguan-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="generate-suguan-title">Generate Suguan</h3>
            {/* Update #22 §1 — the target week is chosen HERE; the ISO year is the
                dashboard's current ISO year and is never silently changed. */}
            <label className="field">
              <span>ISO WEEK</span>
              <select
                value={week}
                onChange={(e) => {
                  setWeek(Number(e.target.value));
                  setBlocked(null);
                }}
                disabled={busy}
              >
                {weekOptions.map((w) => (
                  <option key={w} value={w}>
                    {w} — {currentYear}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Generation Method — how would you like to generate the weekly Suguan?</span>
              <select
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value as GenerateMode);
                  setBlocked(null);
                }}
                disabled={busy}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
            <p className="info-note">
              ISO WEEK: {week} — {currentYear} · Generation Method: {MODE_LABEL[mode]}
            </p>
            <p className="info-note">
              Auto-generate runs the scheduling engine for ISO W{String(week).padStart(2, "0")} · {currentYear} and
              leaves the week in DRAFT for review. Manual opens the weekly scheduling interface for that week. Assign
              Destinado puts each dako&apos;s Destinado in SUGO with its Katuwang in RESERBA; Assign Katuwang puts the
              Katuwang in SUGO with the Destinado in RESERBA (additional Katuwang rotate fairly into RESERBA II). Duty
              is read from each Guro record; all hard eligibility rules still apply. Weekly Availability must be encoded
              for the selected week first — generation is blocked until it is.
            </p>
            {blocked ? (
              <div className="block-notice" role="alert">
                <strong>Weekly Availability Required</strong>
                <p>{blocked.message}</p>
                {/* Update #24 — land in “fix availability” mode: the missing
                    teachers are highlighted and can be filled in one click. */}
                <a
                  className="btn btn-secondary"
                  href={`/availability?year=${blocked.year}&week=${blocked.week}&fix=1`}
                >
                  Go to Weekly Availability
                </a>
              </div>
            ) : null}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={confirm} disabled={busy}>
                {busy ? "Working…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
        </Modal>
      ) : null}
    </div>
  );
}
