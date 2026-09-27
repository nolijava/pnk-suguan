"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "../_components/modal";

export interface MagRow {
  id: string;
  weekId: string;
  teacherId: string;
  teacherName: string;
  teacherCode: string;
  magType: "SUGO" | "RESERBA";
  seat: number;
  assignmentSource: string;
  isOverride: boolean;
  overrideReason: string | null;
}

interface EligibilityRow {
  teacherId: string;
  teacherName: string;
  eligible: boolean;
  violatedRules: string[];
}

const TYPE_LABEL: Record<"SUGO" | "RESERBA", string> = { SUGO: "SUGO", RESERBA: "RESERBA" };

const RULE_LABEL: Record<string, string> = {
  TEACHER_INACTIVE_MASTER: "Teacher is INACTIVE (master data)",
  NOT_ENCODED: "Availability not encoded",
  INACTIVE_WEEKLY: "Weekly availability INACTIVE",
  ENGLISH_DAKO_EXCLUSION: "Assigned to an English Dako this week",
  OATH_DATE_NOT_REACHED: "Oath-taking date not yet reached",
  ALREADY_ASSIGNED_MAGTUTURO: "Already assigned to a Magtuturo seat this week",
  WEEK_PUBLISHED: "Week is PUBLISHED — unlock first",
};

export function MagtuturoActions({
  weekId,
  weekYear,
  weekNumber,
  monthYear,
  weekStatus,
  serviceDate,
  canWrite,
  canGenerate,
  sugo,
  reserba,
}: {
  weekId: string;
  weekYear: number;
  weekNumber: number;
  monthYear: number;
  weekStatus: "DRAFT" | "FINALIZED" | "PUBLISHED";
  serviceDate: string;
  canWrite: boolean;
  canGenerate: boolean;
  sugo: (MagRow | null)[];
  reserba: (MagRow | null)[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Generate modal (21.11) — its Confirm IS the Update #9 confirmation.
  const [genOpen, setGenOpen] = useState(false);
  const [genMode, setGenMode] = useState<"week" | "month">("week");
  const [genMonth, setGenMonth] = useState(serviceDate.slice(0, 2));
  const [genDetail, setGenDetail] = useState<string[] | null>(null);

  // Manual assignment modal (21.10).
  const [assignSeat, setAssignSeat] = useState<{ magType: "SUGO" | "RESERBA"; seat: number } | null>(null);
  const [elig, setElig] = useState<EligibilityRow[] | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  // Update #8 — focus the search box every time the modal mounts.
  useEffect(() => {
    if (assignSeat) filterRef.current?.focus();
  }, [assignSeat]);

  useEffect(() => {
    if (!assignSeat) return;
    let alive = true;
    fetch(`/api/magtuturo/eligibility?weekId=${weekId}`)
      .then((r) => r.json())
      .then((j) => { if (alive) setElig(j.data ?? []); })
      .catch(() => { if (alive) setElig([]); });
    return () => { alive = false; };
  }, [assignSeat, weekId]);

  const editable = canWrite && weekStatus !== "PUBLISHED";

  function run(body: object, method: "POST" | "DELETE", after?: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/magtuturo", {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (j.data && j.data.ok === false) {
          setError(`${j.data.reason}${j.data.violatedRules?.length ? ` (${j.data.violatedRules.join(", ")})` : ""}`);
          return;
        }
        if (!res.ok) throw new Error(j?.error?.message ?? "Request failed.");
        setAssignSeat(null);
        setSelected(null);
        setFilter("");
        after?.();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed.");
      }
    });
  }

  function generate() {
    setError(null);
    setGenDetail(null);
    startTransition(async () => {
      try {
        const body =
          genMode === "week"
            ? { mode: "week", weekId }
            : { mode: "month", year: monthYear, month: Number(genMonth) };
        const res = await fetch("/api/magtuturo/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error?.message ?? "Generation failed.");
        const detail: string[] = j.data?.weeks
          ? j.data.weeks.map((w: { year?: number; isoWeekNumber?: number; created: number; skipped: boolean; reason?: string; detail: string[] }) => {
              const weekLabel = w.year && w.isoWeekNumber ? `Week ${w.isoWeekNumber} · ${w.year}` : "ISO week";
              const outcome = w.skipped ? `skipped${w.reason ? ` — ${w.reason}` : ""}` : `${w.created} assignment(s) generated`;
              return `${weekLabel}: ${outcome}${w.detail.length ? ` · ${w.detail.join(" · ")}` : ""}`;
            })
          : j.data?.detail ?? [];
        setGenDetail(detail.length > 0 ? detail : [j.data?.skipped ? j.data.reason ?? "Generation skipped." : `Generated ${j.data?.created ?? 0} assignment(s).`]);
        setGenOpen(false); // reveal the result banner — don't leave the dialog up
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Generation failed.");
      }
    });
  }

  function clearSeat(magType: "SUGO" | "RESERBA", seat: number) {
    run({ weekId, magType, seat }, "DELETE");
  }

  const filtered = (elig ?? []).filter((e) =>
    e.teacherName.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  function seatCell(magType: "SUGO" | "RESERBA", seat: number, row: MagRow | null) {
    return (
      <tr key={`${magType}-${seat}`}>
        <td className="actions-col">{seat}</td>
        <td>
          {row ? (
            <strong>{row.teacherName}</strong>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>{row ? row.teacherCode : <span className="muted">—</span>}</td>
        <td className="actions-col">
          {editable && (
            row ? (
              <div className="actions-row">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={pending}
                  onClick={() => setAssignSeat({ magType, seat })}
                >
                  Replace
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={pending}
                  onClick={() => clearSeat(magType, seat)}
                >
                  Clear
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={pending}
                onClick={() => setAssignSeat({ magType, seat })}
              >
                Assign
              </button>
            )
          )}
        </td>
      </tr>
    );
  }

  return (
    <>
      {error && <div className="banner banner-error">{error}</div>}
      {genDetail && genDetail.length > 0 && (
        <div className="banner banner-info">{genDetail.join(" · ")}</div>
      )}

      {canGenerate && weekStatus === "DRAFT" && (
        <p className="actions-row">
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => { setGenMode("week"); setGenOpen(true); }}>
            Generate Weekly
          </button>
          <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => { setGenMode("month"); setGenOpen(true); }}>
            Generate Monthly
          </button>
        </p>
      )}

      {/* 21.12 — assigned-date fields auto-populated from the actual assignment records. */}
      <section className="sched-section">
        <h2>DATE {serviceDate} — SUGO</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Seat</th><th>Pangalan</th><th>Code</th><th>Actions</th></tr>
            </thead>
            <tbody>{sugo.map((row, i) => seatCell("SUGO", i + 1, row))}</tbody>
          </table>
        </div>
      </section>

      <section className="sched-section">
        <h2>DATE {serviceDate} — RESERBA</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Seat</th><th>Pangalan</th><th>Code</th><th>Actions</th></tr>
            </thead>
            <tbody>{reserba.map((row, i) => seatCell("RESERBA", i + 1, row))}</tbody>
          </table>
        </div>
      </section>

      {genOpen && (
        <Modal open={genOpen} onClose={() => !pending && setGenOpen(false)}>
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={genMode === "week" ? "Generate Weekly Magtuturo" : "Generate Monthly Magtuturo"}>
            <div className="modal">
              <h2>{genMode === "week" ? "Generate Weekly Mga Magtuturo" : "Generate Monthly Mga Magtuturo"}</h2>
              <p>
                {genMode === "week"
                  ? `Generate Magtuturo for ISO Week ${weekNumber}, ${weekYear}.`
                  : `Generate Magtuturo week-by-week for every ISO week overlapping the selected Gregorian month in ${monthYear}. Existing or locked weeks are skipped.`}
                {" "}Each generated week targets 4 SUGO + 2 RESERBA and remains <strong>DRAFT</strong>.
              </p>
              {genMode === "month" ? (
                <label className="form-field">
                  <span>Month · {monthYear}</span>
                  <select value={genMonth} onChange={(e) => setGenMonth(e.target.value)}>
                    {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => setGenOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" disabled={pending} onClick={generate}>
                  {pending ? "Generating…" : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {assignSeat && (
        <Modal open={!!assignSeat} onClose={() => !pending && setAssignSeat(null)}>
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Manual Assignment">
            <div className="modal">
              <h2>Manual Assignment — {TYPE_LABEL[assignSeat.magType]} seat {assignSeat.seat}</h2>
              <p>Week {weekNumber} · {weekYear} — DATE {serviceDate}</p>
              <label className="form-field">
                <span>Search Name</span>
                <input
                  ref={filterRef}
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Type a teacher name…"
                />
              </label>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Pangalan</th><th>Status</th><th></th></tr>
                  </thead>
                  <tbody>
                    {elig === null ? (
                      <tr><td colSpan={3}>Loading…</td></tr>
                    ) : filtered.length === 0 ? (
                      <tr><td colSpan={3}>No teachers match.</td></tr>
                    ) : (
                      filtered.map((e) => (
                        <tr key={e.teacherId}>
                          <td>{e.teacherName}</td>
                          <td>
                            {e.eligible
                              ? "Eligible"
                              : e.violatedRules.map((r) => RULE_LABEL[r] ?? r).join(" · ")}
                          </td>
                          <td className="actions-col">
                            <button
                              type="button"
                              className={`btn btn-sm ${selected === e.teacherId ? "btn-primary" : "btn-secondary"}`}
                              disabled={!e.eligible || pending}
                              onClick={() => setSelected(e.teacherId)}
                            >
                              Select
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={pending}
                  onClick={() => { setAssignSeat(null); setSelected(null); setFilter(""); }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!selected || pending}
                  onClick={() =>
                    selected &&
                    run(
                      { weekId, teacherId: selected, magType: assignSeat.magType, seat: assignSeat.seat },
                      "POST",
                    )
                  }
                >
                  {pending ? "Assigning…" : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
