"use client";

import { useState, useTransition } from "react";
import { Modal } from "./modal";

export interface ConfirmDialogProps {
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel?: string;
  requireReason?: boolean;
  hiddenFields?: Record<string, string>;
  action: (formData: FormData) => Promise<void>;
  className?: string;
  disabled?: boolean;
}

/** Modal confirmation with optional mandatory reason. Server action runs on confirm. */
export function ConfirmDialog({
  triggerLabel,
  title,
  description,
  confirmLabel = "Confirm",
  requireReason = false,
  hiddenFields = {},
  action,
  className,
  disabled,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(formData: FormData) {
    if (requireReason && !String(formData.get("reason") ?? "").trim()) {
      setError("Reason is required.");
      return;
    }
    setError(null);
    startTransition(async () => {
      await action(formData);
      setOpen(false);
    });
  }

  return (
    <>
      <button type="button" className={className ?? "btn btn-secondary"} onClick={() => setOpen(true)} disabled={disabled}>
        {triggerLabel}
      </button>
      {open ? (
        <Modal open onClose={() => setOpen(false)}>
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
          <div className="modal">
            <h2>{title}</h2>
            <p>{description}</p>
            {error ? <p className="error">{error}</p> : null}
            <form action={submit} className="form-col">
              {Object.entries(hiddenFields).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              {requireReason ? (
                <label>
                  Reason (required)
                  <textarea name="reason" rows={3} required autoFocus />
                </label>
              ) : null}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)} disabled={pending}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={pending}>
                  {pending ? "Working…" : confirmLabel}
                </button>
              </div>
            </form>
          </div>
        </div>
        </Modal>
      ) : null}
    </>
  );
}
