/**
 * REVISION #1 regression — the shared Modal must not re-run its focus/scroll
 * lifecycle on a parent re-render.
 *
 * WHY THIS FILE EXISTS. The Create User dialog threw the caret into the Email
 * box after every character typed in Full Name or Temporary Password. The bug
 * was not in the form: `Modal`'s lifecycle effect listed `onClose` in its
 * dependency array, and every call site passes an inline arrow
 * (`onClose={() => setDialog(null)}`). A new function identity on every parent
 * render — and in a controlled form, every keystroke IS a parent render — made
 * React run the effect's cleanup and body again: the cleanup restored focus to
 * the trigger outside the dialog, and the body then moved it to the panel's
 * first focusable control (Email).
 *
 * There is no DOM environment in this repo (no jsdom), so the behavioural proof
 * lives in the browser pass recorded in the revision report. What CAN be pinned
 * in-suite is the shape that made the bug possible, and that is what this file
 * asserts — an unstable dependency must never return to a focus/scroll effect.
 * Reading the component source is deliberate: the defect is a dependency
 * array, and a dependency array is not observable through behaviour tests that
 * the repo can currently run.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE = readFileSync(
  path.resolve(__dirname, "../../src/app/(admin)/_components/modal.tsx"),
  "utf8",
);

type Effect = { body: string; deps: string[] };

/** Every multi-line `useEffect(() => { … }, [deps]);` in the file. */
function effects(source: string): Effect[] {
  const found: Effect[] = [];
  const re = /useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]*)\]\);/g;
  for (const match of source.matchAll(re)) {
    found.push({
      body: match[1] ?? "",
      deps: (match[2] ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
    });
  }
  return found;
}

const ALL = effects(SOURCE);
/** Effects that move focus or lock the page behind the dialog. */
const LIFECYCLE = ALL.filter((e) => /focus\(|style\.overflow/.test(e.body));

describe("Modal — focus/scroll effects are keyed on stable values only", () => {
  it("finds the effects it is meant to guard", () => {
    // If the component is restructured, fail loudly instead of silently passing.
    expect(LIFECYCLE.length, "expected the focus/scroll effects to exist").toBeGreaterThanOrEqual(2);
  });

  it("no focus/scroll effect depends on the caller's inline `onClose`", () => {
    for (const effect of LIFECYCLE) {
      expect(
        effect.deps,
        "an effect that moves focus must not re-run whenever the parent re-renders",
      ).not.toContain("onClose");
    }
  });

  it("keys the scroll-lock + previous-focus restore on [open, lockScroll] alone", () => {
    const lifecycle = ALL.find((e) => e.body.includes("document.body.style.overflow"));
    expect(lifecycle, "the scroll-lock effect must exist").toBeTruthy();
    expect(lifecycle!.deps).toEqual(["open", "lockScroll"]);
    // The restore belongs to the same effect, and therefore to one close/unmount.
    expect(lifecycle!.body).toContain("previousFocus?.focus?.()");
  });

  it("keys focus-into-the-dialog on [open, mounted] so it runs once, after the portal exists", () => {
    const focusIn = ALL.find((e) => e.body.includes('panel.querySelector'));
    expect(focusIn, "the focus-into-dialog effect must exist").toBeTruthy();
    expect(focusIn!.deps).toEqual(["open", "mounted"]);
    // It must never steal focus from inside the panel.
    expect(focusIn!.body).toContain("panel.contains(document.activeElement)");
  });

  it("keeps Escape wired to the LATEST onClose through a ref", () => {
    expect(SOURCE).toContain("const onCloseRef = useRef(onClose)");
    expect(SOURCE).toContain("onCloseRef.current = onClose");
    // Escape reads the ref, never the prop captured at mount time.
    expect(SOURCE).toContain("onCloseRef.current()");
    expect(SOURCE).not.toMatch(/e\.key === "Escape" && onClose\)/);
  });
});
