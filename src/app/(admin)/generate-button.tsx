"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Phase 6 §16-§19 — dashboard "Generate Suguan" entry point. Never generates
 * by itself: Auto reuses the EXISTING Phase 4 scheduling flow on the weekly
 * page (which owns the previous-week absence warning, DRAFT lifecycle and
 * regeneration rules), Manual routes to /schedule, Cancel does nothing.
 * No second scheduling engine, no client-side logic beyond navigation.
 */
export function GenerateSuguanButton({ currentYear, currentWeek }: { currentYear: number; currentWeek: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Real navigation state only — the button reflects the actual transition.
  const [navigating, startNavigation] = useTransition();
  const weeklyHref = `/schedule?year=${currentYear}&week=${currentWeek}`;

  return (
    <div className="generate-suguan">
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen(true)}
        disabled={navigating}
        aria-busy={navigating}
      >
        {navigating ? <span className="spinner" aria-hidden="true" /> : null}
        {navigating ? "Opening schedule…" : "Generate Suguan"}
      </button>
      {open ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="generate-suguan-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="generate-suguan-title">How would you like to generate the weekly Suguan?</h3>
            <p className="info-note">
              Auto-generate uses the existing scheduling engine for ISO W{currentWeek} · {currentYear} (including the
              previous-week absence warning). Manual opens the weekly scheduling interface.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setOpen(false);
                  startNavigation(() => router.push(`${weeklyHref}&generate=auto`));
                }}
              >
                Auto-generate
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setOpen(false);
                  startNavigation(() => router.push(weeklyHref));
                }}
              >
                Manual
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
