/**
 * REVISION #3 (corrected) regression — every button gets a HOVER-ONLY, thin
 * vivid-yellow + vivid-purple circulating outline, and nothing else changes.
 *
 * WHY THIS FILE EXISTS. The first Revision #3 attempt was scoped to a single
 * `btn-create` class, gave that one button a bright background of its own, kept
 * its ring visible at rest, and used cyan/yellow/magenta. The corrected
 * revision inverts all of that: the ring belongs to the shared `.btn` family,
 * appears only on hover/focus, is strictly yellow + purple, and leaves every
 * button's normal appearance — background, gradient, text, border, shadow — as
 * it was in both themes.
 *
 * There is no DOM environment in this repo (no jsdom), so the live proof lives
 * in the browser pass recorded in the revision report. What CAN be pinned
 * in-suite is the CSS shape that carries those requirements, which is what this
 * file asserts. It reads `globals.css` directly and fails loudly if the shape is
 * restructured, rather than passing vacuously.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const CSS = readFileSync(path.resolve(__dirname, "../../src/app/globals.css"), "utf8");

/** Comments describe the intent and name colours ("blue", "cyan"); strip them so
 *  only real declarations are inspected. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; body: string };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const ALL_RULES: Rule[] = [...RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: norm(m[1] ?? ""),
  body: norm(m[2] ?? ""),
}));

/** Every rule that actually paints a ring sweep (`@keyframes` and the reveal
 *  rules read the same custom property, so the gradient itself is the tell). */
const RING_PAINTERS = ALL_RULES.filter((r) => r.body.includes("conic-gradient") && r.body.includes("--ring-angle"));

/** The rule that paints the ring itself. */
const RING = ALL_RULES.find((r) => r.selector === ".btn::after" && r.body.includes("conic-gradient"));
/** The rule that reveals + spins it. */
const TRIGGER = ALL_RULES.find(
  (r) => r.selector === ".btn:not([disabled]):hover::after, .btn:not([disabled]):focus-visible::after",
);

const HOVER_TRIGGER_RULES = ALL_RULES.filter((r) => /:hover::after/.test(r.selector));

describe("Revision #3 — hover ring: scope", () => {
  it("defines exactly one ring, on the shared `.btn` family", () => {
    expect(RING, "the `.btn::after` ring must exist").toBeTruthy();
    expect(RING_PAINTERS.map((r) => r.selector)).toEqual([".btn::after"]);
  });

  it("applies to every button variant through the shared class, not per component", () => {
    // The variants themselves must not carry their own ring rule: one shared
    // rule is what keeps primary/secondary/danger/ghost consistent.
    for (const variant of [".btn-primary::after", ".btn-secondary::after", ".btn-danger::after", ".btn-ghost::after"]) {
      expect(ALL_RULES.some((r) => r.selector === variant), `${variant} must not duplicate the ring`).toBe(false);
    }
    // ...and the one-off create scoping from the first attempt is gone.
    expect(RULES).not.toContain("btn-create");
  });

  it("keeps the ring inside the button's own stacking context", () => {
    const base = ALL_RULES.find((r) => r.selector === ".btn");
    expect(base, "the `.btn` base rule must exist").toBeTruthy();
    expect(base!.body).toContain("position: relative");
    expect(base!.body).toContain("isolation: isolate");
    // Absolutely positioned + pointer-transparent: it can never move a control
    // or intercept a click.
    expect(RING!.body).toContain("position: absolute");
    expect(RING!.body).toContain("pointer-events: none");
  });

  it("never lets the ring escape onto non-button elements", () => {
    expect(RING_PAINTERS.length).toBeGreaterThan(0);
    for (const rule of RING_PAINTERS) {
      expect(rule.selector, "only buttons may paint the ring").toMatch(/\.btn/);
    }
  });
});

describe("Revision #3 — hover ring: hover-only", () => {
  it("is invisible at rest, so no button's normal appearance changes", () => {
    expect(RING!.body).toMatch(/opacity: 0(;|$)/);
    expect(RING!.body).not.toMatch(/opacity: 0\.[1-9]/);
  });

  it("is revealed only by hover or keyboard focus", () => {
    expect(TRIGGER, "the hover/focus reveal rule must exist").toBeTruthy();
    expect(TRIGGER!.body).toMatch(/opacity: 0\.[0-9]/);
    expect(TRIGGER!.body).toContain("pnk-rotate");
    for (const rule of HOVER_TRIGGER_RULES) {
      expect(rule.selector).toMatch(/^\.btn:not\(\[disabled\]\):(hover|focus-visible)::after/);
    }
  });

  it("stays hidden on disabled buttons", () => {
    const disabled = ALL_RULES.find((r) => r.selector === ".btn[disabled]::after");
    expect(disabled, "`.btn[disabled]::after` must keep the ring off").toBeTruthy();
    expect(disabled!.body).toContain("display: none");
  });

  it("keeps a static outline (not the animation) under reduced motion", () => {
    const block = norm(RULES.slice(RULES.indexOf("prefers-reduced-motion")));
    expect(block).toContain(
      ".btn:not([disabled]):hover::after, .btn:not([disabled]):focus-visible::after { animation: none; opacity: 0.9; }",
    );
    // The outline must survive — reduced motion stops the circulation, it does
    // not remove the hover affordance.
    expect(block).not.toContain(".btn:not([disabled]):hover::after, .btn:not([disabled]):focus-visible::after { opacity: 0; }");
  });

  it("animates ONLY while hovered — an idle page has no ring animation to composite", () => {
    // The circulation is attached in exactly one place, and that rule requires
    // `:hover`/`:focus-visible`. The ring's own rule must stay animation-free,
    // so no frame is produced until a pointer or keyboard focus arrives.
    const animators = ALL_RULES.filter((r) => /pnk-rotate/.test(r.body));
    expect(animators.map((r) => r.selector)).toEqual([
      ".btn:not([disabled]):hover::after, .btn:not([disabled]):focus-visible::after",
    ]);
    expect(RING!.body).not.toContain("animation");
  });
});

describe("Revision #3 — hover ring: palette", () => {
  it("is a 2px ring — the `inset`/`padding` pair sizes the band", () => {
    expect(RING!.body).toContain("padding: 2px");
    expect(RING!.body).toContain("inset: -2px");
    expect(RING!.body).toContain("border-radius: calc(var(--radius-sm) + 2px)");
  });

  it("uses vivid yellow and vivid purple and nothing else", () => {
    expect(RING!.body).toContain(
      "conic-gradient(from var(--ring-angle), var(--ring-yellow), var(--ring-purple), var(--ring-yellow))",
    );
    // The forbidden palette from the first attempt must not come back, in any
    // form: named hues, the old blue/emerald/gold tokens, or their hexes.
    for (const forbidden of ["--blue-500", "--emerald-500", "--gold-500", "#22d3ee", "#ff2fb9", "fuchsia", "magenta", "cyan"]) {
      expect(RING!.body, `the ring must not use ${forbidden}`).not.toContain(forbidden);
      expect(TRIGGER!.body, `the ring trigger must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("declares those two tokens as vivid, theme-independent values", () => {
    const tokens = [...RULES.matchAll(/--ring-(?:yellow|purple): ([^;]+);/g)].map((m) => m[1]!.trim());
    expect(tokens).toEqual(["#ffe23d", "#a855f7"]);
  });

  it("leaves the existing blue accent and button backgrounds untouched", () => {
    // Revision #3 must not repaint any button at rest: the tokens that drive
    // their normal appearance stay exactly as authored.
    expect(RULES).toMatch(/--btn-bg: var\(--blue-600\);/);
    expect(RULES).toMatch(/--btn-bg-hover: var\(--blue-500\);/);
  });
});

describe("Revision #3 — blue buttons: hover surface", () => {
  const LIGHT_SURFACE = /linear-gradient\(135deg, #fffcea 0%, #fbfbf3 48%, #edeef2 100%\)/;
  const PRIMARY_HOVER = ALL_RULES.find((r) => r.selector === ".btn-primary:hover");

  it("gives the blue (`btn-primary`) button a very light yellow → light gray hover fill", () => {
    expect(PRIMARY_HOVER, "the `.btn-primary:hover` rule must exist").toBeTruthy();
    expect(PRIMARY_HOVER!.body).toMatch(LIGHT_SURFACE);
    // It must not keep painting the bright blue hover fill.
    expect(PRIMARY_HOVER!.body).not.toContain("--btn-bg-hover");
  });

  it("applies that hover fill to blue buttons ONLY", () => {
    const holders = ALL_RULES.filter((r) => LIGHT_SURFACE.test(r.body));
    expect(holders.map((r) => r.selector)).toEqual([".btn-primary:hover"]);
    // Every other variant keeps its own authored hover treatment.
    for (const sel of [".btn-secondary:hover", ".btn-danger:hover", ".btn-ghost:hover, .ghost:hover"]) {
      const rule = ALL_RULES.find((r) => r.selector === sel);
      expect(rule, `${sel} must still exist`).toBeTruthy();
      expect(rule!.body, `${sel} must not take the light-blue-button fill`).not.toMatch(LIGHT_SURFACE);
    }
  });

  it("keeps the blue button's normal fill blue", () => {
    const base = ALL_RULES.find((r) => r.selector === ".btn-primary");
    expect(base, "the `.btn-primary` base rule must exist").toBeTruthy();
    expect(base!.body).toContain("background-color: var(--btn-bg)");
    expect(base!.body).toContain("color: var(--btn-fg)");
    expect(base!.body).not.toMatch(LIGHT_SURFACE);
  });

  it("keeps the hover label dark enough for the light surface, in both themes", () => {
    // `--btn-fg-hover` is the label used on the hover surface; on a near-white
    // fill it has to be dark, and it is authored dark in BOTH theme blocks.
    const declarations = [...RULES.matchAll(/--btn-fg-hover: var\(--navy-950\);/g)];
    expect(declarations.length, "light AND dark must both set a dark hover label").toBe(2);
    expect(PRIMARY_HOVER!.body).toContain("color: var(--btn-fg-hover)");
  });
});
