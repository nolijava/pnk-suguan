"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./modal";

/**
 * Update #10 — contextual Back/Return control for forms.
 *
 * Navigates to the caller's logical previous screen (not the Dashboard). When
 * the form holds unsaved changes, leaving asks first — entered data is never
 * silently discarded. A real form SUBMIT clears the dirty flag first (the
 * browser's own unload must not prompt after a successful save), and browser
 * Back is covered by a native beforeunload warning while dirty.
 */
export function UnsavedBack({
  href,
  label = "Cancel",
  className,
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const dirtyRef = useRef(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const form = btnRef.current?.closest("form");
    if (!form) return;
    const onInput = () => { dirtyRef.current = true; };
    const onSubmit = () => { dirtyRef.current = false; };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    form.addEventListener("input", onInput);
    form.addEventListener("change", onInput);
    form.addEventListener("submit", onSubmit);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      form.removeEventListener("input", onInput);
      form.removeEventListener("change", onInput);
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  function leave() {
    dirtyRef.current = false;
    router.push(href);
  }

  function onClick() {
    if (dirtyRef.current) setOpen(true);
    else leave();
  }

  return (
    <>
      <button ref={btnRef} type="button" className={className ?? "btn btn-secondary"} onClick={onClick}>
        {label}
      </button>
      {open && (
        <Modal open={open} onClose={() => setOpen(false)}>
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Discard unsaved changes?">
            <div className="modal">
              <h2>Discard unsaved changes?</h2>
              <p>You have entered data that has not been saved. Leaving now discards it.</p>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
                  Keep editing
                </button>
                <button type="button" className="btn btn-primary" onClick={leave}>
                  Discard and leave
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
