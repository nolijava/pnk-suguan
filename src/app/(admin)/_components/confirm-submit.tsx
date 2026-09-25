"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Modal } from "./modal";

export interface ConfirmSubmitProps {
  /** Button label, e.g. "Create Teacher" or "+ Add Another Guro". */
  label: string;
  /** Confirmation modal title — states the action being performed. */
  confirmTitle: string;
  confirmDescription?: string;
  confirmLabel?: string;
  /** Form field names echoed back as the affected data. */
  summaryFields?: { name: string; label: string }[];
  /** Extra hidden field written on confirm (e.g. Add Another flow). */
  submitName?: string;
  submitValue?: string;
  variant?: "primary" | "secondary";
  className?: string;
}

/**
 * Update #9 — `Action → Confirmation Modal → Confirm → Mutation` for forms.
 *
 * The button never submits directly: it opens the confirmation (showing the
 * action and the affected data read from the live form), and only Confirm
 * triggers the form's server action via requestSubmit(). Cancel mutates
 * nothing and leaves every entered value in place.
 *
 * The modal can never lock the UI: constraint validation runs BEFORE anything
 * is armed (an invalid form just reports and reopens the form to fix the
 * field), and the busy state is derived from React's form status so it always
 * resolves once the action settles — whatever the outcome.
 */
export function ConfirmSubmit({
  label,
  confirmTitle,
  confirmDescription,
  confirmLabel = "Confirm",
  summaryFields,
  submitName,
  submitValue,
  variant = "primary",
  className,
}: ConfirmSubmitProps) {
  const { pending } = useFormStatus();
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [summary, setSummary] = useState<{ label: string; value: string }[]>([]);
  const formRef = useRef<HTMLFormElement | null>(null);
  const hiddenRef = useRef<HTMLInputElement | null>(null);
  const busy = armed || pending;

  // Recovery net: when the form action settles without navigating (an error
  // notice, a soft redirect back onto the form), unlock and close the modal
  // and drop the transient submit field so a later plain submit can never
  // inherit "Add Another" intent. On a real navigation this component
  // unmounts first — the cleanup below removes the field there.
  useEffect(() => {
    if (pending) return;
    setArmed(false);
    setOpen(false);
    hiddenRef.current?.remove();
    hiddenRef.current = null;
  }, [pending]);

  useEffect(() => () => hiddenRef.current?.remove(), []);

  function openConfirm(e: React.MouseEvent<HTMLButtonElement>) {
    if (busy) return;
    const form = e.currentTarget.closest("form");
    formRef.current = form;
    if (summaryFields && form) {
      setSummary(
        summaryFields.map((f) => {
          const el = form.querySelector<HTMLElement>(`[name="${f.name}"]`);
          let value = "";
          if (el instanceof HTMLInputElement && el.type === "radio") {
            const checked = form.querySelector<HTMLInputElement>(
              `input[type="radio"][name="${f.name}"]:checked`,
            );
            value = checked?.value ?? "";
          } else if (el instanceof HTMLInputElement) {
            if (el.type === "checkbox") value = el.checked ? "Yes" : "No";
            else value = el.value;
          } else if (el instanceof HTMLSelectElement) {
            value = el.selectedOptions[0]?.text ?? "";
          } else if (el instanceof HTMLTextAreaElement) {
            value = el.value;
          }
          return { label: f.label, value: value.trim() || "—" };
        }),
      );
    }
    setOpen(true);
  }

  function confirm() {
    const form = formRef.current;
    if (!form || busy) return;
    // Validate FIRST: a blocked submission must never arm the modal, and the
    // form behind the backdrop has to be reachable again to fix the field.
    if (!form.checkValidity()) {
      form.reportValidity();
      setOpen(false);
      return;
    }
    if (submitName) {
      let hidden = hiddenRef.current;
      if (!hidden) {
        hidden = document.createElement("input");
        hidden.type = "hidden";
        hidden.name = submitName;
        form.appendChild(hidden);
        hiddenRef.current = hidden;
      }
      hidden.value = submitValue ?? "1";
    }
    setArmed(true);
    form.requestSubmit();
  }

  return (
    <>
      <button
        type="button"
        className={className ?? `btn btn-${variant}`}
        onClick={openConfirm}
        disabled={busy}
      >
        {label}
      </button>
      {open && (
        <Modal open={open} onClose={() => !busy && setOpen(false)}>
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={confirmTitle}>
            <div className="modal">
              <h2>{confirmTitle}</h2>
              {confirmDescription ? <p>{confirmDescription}</p> : null}
              {summary.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Field</th><th>Value</th></tr>
                    </thead>
                    <tbody>
                      {summary.map((s) => (
                        <tr key={s.label}>
                          <td>{s.label}</td>
                          <td>{s.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={confirm}
                >
                  {busy ? "Saving…" : confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
