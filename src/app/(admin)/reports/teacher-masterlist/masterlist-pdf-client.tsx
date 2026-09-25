"use client";

import { useState } from "react";
import { Modal } from "@/app/(admin)/_components";
import {
  MASTERLIST_DEFAULT_FIELDS,
  MASTERLIST_FIELDS,
  MASTERLIST_FIELD_CODES,
  type MasterlistFieldCode,
} from "@/lib/masterlist";

/**
 * New Update #4 — the field-selection modal for the Teacher Masterlist PDF.
 *
 * The operator ticks exactly the Teacher information to export; the "Generate
 * PDF" link is built from THAT selection, so the file contains the selected
 * fields and nothing else. Only real fields are offered (the catalogue in
 * `@/lib/masterlist` mirrors the master schema 1:1) and the filters currently
 * applied on the page are carried into the PDF.
 *
 * The selection is enforced again server-side: the PDF route validates every
 * field code against the same allow-list and REJECTS an unknown one.
 */
export function MasterlistPdfModal({
  filters,
  total,
}: {
  filters: { status?: string; language?: string; duty?: string };
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MasterlistFieldCode[]>([...MASTERLIST_DEFAULT_FIELDS]);

  const toggle = (code: MasterlistFieldCode) => {
    setSelected((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const ordered = MASTERLIST_FIELD_CODES.filter((c) => selected.includes(c));
  const params = new URLSearchParams();
  if (ordered.length) params.set("fields", ordered.join(","));
  if (filters.status) params.set("status", filters.status);
  if (filters.language) params.set("language", filters.language);
  if (filters.duty) params.set("duty", filters.duty);
  const href = `/api/reports/teacher-masterlist/pdf${params.toString() ? `?${params.toString()}` : ""}`;

  const filterNote = [
    filters.status ? `status ${filters.status}` : null,
    filters.language ? `language ${filters.language}` : null,
    filters.duty ? `duty ${filters.duty}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        Generate PDF — choose fields…
      </button>
      {open ? (
        <Modal open onClose={() => setOpen(false)}>
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Teacher Masterlist PDF">
            <div className="modal modal-wide">
              <h2>Teacher Masterlist — fields to export</h2>
              <p className="info-note">
                {total} teacher(s) match the current filters{filterNote ? ` (${filterNote})` : ""}. Only the ticked
                fields are written to the PDF. Age is always computed from Birthday, never stored.
              </p>

              <div className="actions-row">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSelected([...MASTERLIST_FIELD_CODES])}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSelected([...MASTERLIST_DEFAULT_FIELDS])}
                >
                  Core fields
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setSelected([])}>
                  Clear
                </button>
              </div>

              <fieldset className="masterlist-fields">
                <legend className="sr-only">Masterlist fields</legend>
                {MASTERLIST_FIELD_CODES.map((code) => (
                  <label key={code} className="masterlist-field">
                    <input
                      type="checkbox"
                      checked={selected.includes(code)}
                      onChange={() => toggle(code)}
                    />
                    <span>
                      <strong>{MASTERLIST_FIELDS[code].label}</strong>
                      <span className="info-note"> — {MASTERLIST_FIELDS[code].source}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {ordered.length === 0 ? (
                <p className="field-error">Select at least one field to generate the PDF.</p>
              ) : (
                <p className="info-note">
                  {ordered.length} field(s) selected — columns, in this order:{" "}
                  {ordered.map((c) => MASTERLIST_FIELDS[c].label).join(", ")}
                </p>
              )}

              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                {ordered.length === 0 ? (
                  <button type="button" className="btn btn-primary" disabled>
                    Generate PDF
                  </button>
                ) : (
                  <a className="btn btn-primary" href={href} rel="nofollow">
                    Generate PDF
                  </a>
                )}
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
