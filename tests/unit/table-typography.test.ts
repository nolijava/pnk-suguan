/**
 * New Update #9 + #10 — shared table typography, and the Dashboard's two
 * dedicated exceptions (its own cell typography and its seven micro-badge hues).
 *
 * WHY THIS FILE EXISTS. Update #9 asks for ONE table scale on every page —
 * header 10px, data 12.5px, badges 10px, in-table buttons 11px — while the
 * Dashboard matrix keeps the cell typography from the previous updates. Both
 * halves are easy to break silently: a later edit to `.badge` or `th` would
 * leak into the matrix, and a badge hue could quietly be re-pointed at a shared
 * semantic token, which is exactly how OVERRIDE and ABSENT ended up identical
 * (`--red-500` and `--red-solid-500` are both `#c94c4c`).
 *
 * There is no DOM environment in this repo, so this file reads `globals.css`
 * (and the badge registry in `annual-client.tsx`) directly and fails loudly if
 * the shape is restructured, rather than passing vacuously.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const CSS = readFileSync(path.resolve(__dirname, "../../src/app/globals.css"), "utf8");
const CLIENT = readFileSync(path.resolve(__dirname, "../../src/app/(admin)/annual-client.tsx"), "utf8");

/** Strip comments so intent prose ("navy", "red") is never mistaken for a value. */
const RULES_CSS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type Rule = { selector: string; body: string };
const ALL_RULES: Rule[] = [...RULES_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: norm(m[1] ?? ""),
  body: norm(m[2] ?? ""),
}));

const rule = (selector: string): Rule => {
  const found = ALL_RULES.find((r) => r.selector === selector);
  expect(found, `the \`${selector}\` rule must exist`).toBeTruthy();
  return found!;
};

const fontSize = (body: string): string | undefined => /font-size: ([^;]+)/.exec(body)?.[1]?.trim();

/** The registry is the source of truth for which identifiers exist. */
const REGISTRY_IDS = [
  ...(/export const CELL_BADGES: Record<string, \{ label: string; paths: string\[\] \}> = \{([\s\S]*?)\n\};/.exec(
    CLIENT,
  )?.[1] ?? "").matchAll(/^\s{2}([A-Z_]+):/gm),
].map((m) => m[1]!);

const CB_RULES = ALL_RULES.filter((r) => /^\.cb-[a-z0-9_]+$/.test(r.selector));

describe("New Update #9 — one shared table scale", () => {
  it("sets data cells to 12.5px and headers to 10px", () => {
    expect(fontSize(rule("th, td").body)).toBe("12.5px");
    expect(fontSize(rule("th").body)).toBe("10px");
  });

  it("sets badge labels to 10px", () => {
    expect(fontSize(rule(".badge").body)).toBe("10px");
  });

  it("sets buttons INSIDE a table to 11px, without resizing .btn elsewhere", () => {
    const inTable = ALL_RULES.filter(
      (r) => fontSize(r.body) === "11px" && /(^|,\s*)(td \.btn|\.table-wrap \.btn)/.test(r.selector),
    );
    expect(inTable.length, "an in-table button rule must exist").toBeGreaterThan(0);
    for (const r of inTable) {
      expect(r.selector).toMatch(/td \.btn/);
      expect(r.selector).toMatch(/\.table-wrap \.btn/);
    }
    // The shared button base is untouched — a page-header button must not shrink.
    expect(fontSize(rule(".btn").body)).toBe("14px");
  });

  it("keeps the responsive card label at the data size", () => {
    expect(rule(".data-table td[data-label]").body).toContain("font-size: 12.5px");
  });

  it("pins the Dashboard matrix typography so the shared scale cannot reach it", () => {
    expect(fontSize(rule(".annual-table th, .annual-table td").body)).toBe("12.5px");
    expect(fontSize(rule(".annual-table thead th").body)).toBe("11px");
    expect(fontSize(rule(".annual-table .badge").body)).toBe("11.5px");
    expect(fontSize(rule(".cell-name").body)).toBe("8pt");
    // New Update #1 — the Dako NAME (row header) at the teacher-name size.
    expect(fontSize(rule(".annual-table tbody .dako-row-head").body)).toBe("8pt");
  });

  it("scopes the Dako-name rule to the matrix BODY (never the column header)", () => {
    const rule_ = rule(".annual-table tbody .dako-row-head");
    expect(rule_.selector).toContain("tbody");
    expect(rule_.selector).not.toMatch(/thead|\.dako-col[^-]/);
  });

  it("marks the Dako row header in the component (class actually applied)", () => {
    expect(CLIENT).toContain('className="dako-col dako-row-head"');
    // …and the teacher-name span is untouched by Update #1.
    expect(CLIENT).toContain('className="cell-name"');
  });
});

describe("New Update #10 — one distinctive hue per Dashboard micro-badge", () => {
  it("registers the seven identifiers and gives every one a .cb- rule", () => {
    expect(REGISTRY_IDS.sort()).toEqual(
      ["ABSENT", "FINALIZED", "HISTORICAL", "MANUAL", "OVERRIDE", "PUBLISHED", "UPDATED"].sort(),
    );
    for (const id of REGISTRY_IDS) {
      expect(
        CB_RULES.some((r) => r.selector === `.cb-${id.toLowerCase()}`),
        `.cb-${id.toLowerCase()} must exist`,
      ).toBe(true);
    }
    expect(CB_RULES).toHaveLength(REGISTRY_IDS.length);
  });

  it("points every identifier at its OWN token (no two identifiers share one)", () => {
    const tokens = CB_RULES.map((r) => /--mb-ring: var\((--[a-z0-9-]+)\)/.exec(r.body)?.[1] ?? "");
    expect(tokens).toHaveLength(7);
    for (const t of tokens) expect(t, "each .cb- rule must read a --mb-* token").toMatch(/^--mb-/);
    expect(new Set(tokens).size, "the seven ring tokens must be distinct").toBe(7);
    // No identifier may borrow a shared semantic token any more.
    for (const r of CB_RULES) {
      expect(r.body, `${r.selector} must not use a semantic token`).not.toMatch(
        /var\(--(red-solid-500|red-500|blue-600|blue-500|gold-500|emerald-500|navy-900|accent-solid)/,
      );
    }
  });

  it("declares all seven tokens in BOTH themes with distinct literal values", () => {
    for (const selector of [":root", '[data-theme="dark"]']) {
      const body = rule(selector).body;
      const values = [...body.matchAll(/--mb-(published|finalized|override|manual|historical|updated|absent): (#[0-9a-fA-F]{3,8})/g)];
      expect(values, `${selector} must set all seven hues`).toHaveLength(7);
      expect(new Set(values.map((v) => v[2])).size, `the seven ${selector} hues must be distinct`).toBe(7);
    }
  });

  it("documents the historical collision so the fix cannot be undone by accident", () => {
    // OVERRIDE and ABSENT were the same value in the old palette; both hues must
    // now differ from each other in each theme.
    for (const selector of [":root", '[data-theme="dark"]']) {
      const body = rule(selector).body;
      const override = /--mb-override: (#[0-9a-fA-F]{3,8})/.exec(body)?.[1];
      const absent = /--mb-absent: (#[0-9a-fA-F]{3,8})/.exec(body)?.[1];
      const finalized = /--mb-finalized: (#[0-9a-fA-F]{3,8})/.exec(body)?.[1];
      const updated = /--mb-updated: (#[0-9a-fA-F]{3,8})/.exec(body)?.[1];
      expect(override).not.toBe(absent);
      expect(finalized).not.toBe(updated);
    }
  });

  it("keeps the ring/fill mechanism, icon stroke and label wiring", () => {
    expect(rule(".cell-badge").body).toContain("border-radius: 50%");
    expect(rule(".cell-badge").body).toContain("--mb-ring");
    expect(rule(".cell-badge").body).toContain("--mb-fill");
    expect(rule(".cell-badge svg path").body).toContain("--mb-icon");
    // Icons + accessible labels + the tooltip legend are untouched.
    expect(CLIENT).toContain('className={`cell-badge cb-${b.toLowerCase()}`}');
    expect(CLIENT).toContain("aria-label={CELL_BADGES[b]?.label ?? b}");
    expect(CSS).toContain(".cell-tooltip-badge");
    // Badges are static: no animation was introduced by this update.
    for (const r of CB_RULES) expect(r.body).not.toContain("animation");
    expect(rule(".cell-badge").body).not.toContain("animation");
  });
});
