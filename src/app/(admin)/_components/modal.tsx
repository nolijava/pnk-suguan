"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);

    const previousOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = "hidden";

    // Focus parity: an `autoFocus`ed field inside the dialog wins; otherwise the
    // first meaningful control receives focus. The newest dialog is the last
    // `.modal` in the DOM (portals append in mount order).
    const panels = document.querySelectorAll<HTMLElement>(".modal");
    const panel = panels[panels.length - 1];
    if (panel && !panel.contains(document.activeElement)) {
      const first = panel.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panel).focus();
    }

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [open, onClose, lockScroll]);

  if (!mounted || !open) return null;
  return createPortal(<>{children}</>, document.body);
}
