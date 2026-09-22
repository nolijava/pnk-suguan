"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Shared modal layer (system update — Groups 2 & 4).
 *
 * All dialogs in the app render `.modal-backdrop { position: fixed; inset: 0;
 * display: flex; align-items: center }` — which only centres on the VIEWPORT
 * when no ancestor establishes a containing block for fixed descendants. Any
 * ancestor with a transform, filter, backdrop-filter or persisted animation
 * matrix (e.g. the page-entry animation, or a `.glass-card`) silently turns that
 * into a content-relative overlay, so the dialog ends up centred in the middle
 * of a long page and the user has to scroll to find it.
 *
 * This layer removes that entire class of failure: the dialog's markup is
 * portaled to `document.body`, so `position: fixed` always resolves against the
 * viewport no matter what the page around it does. It deliberately does NOT
 * own any markup — every existing dialog keeps its exact classes, handlers,
 * wording, and fields, so this is a layering change only.
 *
 * It also centralises the behaviour every dialog needs: Escape closes, the page
 * behind cannot scroll, focus moves into the dialog (without stealing it from an
 * `autoFocus` field) and returns to the trigger on close.
 *
 * FOCUS-STEAL FIX (Create User form): this behaviour must run ONCE per open.
 * `onClose` used to sit in the effect's dependency array, and every call site
 * passes an inline arrow (`onClose={() => setDialog(null)}`), so the effect
 * re-ran on EVERY parent render — i.e. on every keystroke in a controlled field.
 * Each re-run first fired the cleanup (`previousFocus?.focus?.()` → the trigger
 * button outside the dialog) and then the body, which found focus outside the
 * panel and moved it to the panel's FIRST focusable control. Typing in Full Name
 * or Temporary Password therefore threw the caret into the Email box after every
 * character. `onClose` now lives in a ref, so the lifecycle effect is keyed on
 * `[open, lockScroll]` alone and the caret stays where the user put it. The
 * focus-into-dialog move is a SEPARATE effect keyed on `[open, mounted]`, so it
 * still runs exactly once per open — after the portal has actually mounted.
 */
export function Modal({
  open,
  onClose,
  lockScroll = true,
  children,
}: {
  open: boolean;
  /** Escape-to-close. Omit for dialogs that must be answered explicitly. */
  onClose?: () => void;
  lockScroll?: boolean;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Latest handler without re-running the effect below (see the focus-steal
  // note above): the ref is updated in its own effect, which changes nothing
  // the user can perceive — no focus move, no scroll-lock churn.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // (1) Lifecycle — ONCE per open: remember where focus came from, stop the page
  // behind from scrolling, and wire Escape. Keyed on `[open, lockScroll]` only,
  // so a parent re-render (a keystroke) can never re-run it.
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onCloseRef.current) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);

    const previousOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      // Once per close/unmount — never on a re-render, which is what used to
      // push focus out of the dialog on every keystroke.
      previousFocus?.focus?.();
    };
  }, [open, lockScroll]);

  // (2) Focus INTO the dialog — once, and only once the portal is really in the
  // DOM. This is why it is not part of (1): the dialog mounts with `mounted`
  // still false (`Modal` is rendered conditionally by its caller), so on the
  // first commit the portal does not exist yet and a single effect keyed on
  // `[open, lockScroll]` would find no `.modal` and silently skip the move. That
  // is how the old code ended up doing it later — on the NEXT parent re-render,
  // i.e. after the first keystroke — which moved the caret to the first control
  // and produced the reported "focus jumps to Email" bug. Keyed on
  // `[open, mounted]` this runs exactly once per open, after the portal commits.
  useEffect(() => {
    if (!open || !mounted) return;
    const panels = document.querySelectorAll<HTMLElement>(".modal");
    const panel = panels[panels.length - 1];
    // Focus parity: an `autoFocus`ed field inside the dialog wins; otherwise the
    // first meaningful control receives focus. Never steal from inside the panel.
    if (!panel || panel.contains(document.activeElement)) return;
    const first = panel.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    (first ?? panel).focus();
  }, [open, mounted]);

  if (!mounted || !open) return null;
  return createPortal(<>{children}</>, document.body);
}
