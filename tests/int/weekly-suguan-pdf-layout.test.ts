/**
 * Weekly Suguan printed form — reference-form LAYOUT contract.
 *
 * Companion to `weekly-suguan-pdf.test.ts` (which owns the DATA/view-model
 * rules and the read-only guarantees). This file pins the PRESENTATION half
 * that the physical reference form (Sugo.pdf) dictates, and — because the
 * geometry is now MEASURED from that reference rather than approximated —
 * it also guards the calibration itself:
 *   §3  page size       — 612 × 936 pt portrait, exactly one page
 *   §8  metadata row    — eight alternating label/value cells, MM/DD/YY date
 *   §9  times           — compact AM/PM (9AM, 12PM, 8:30AM)
 *   §10 dako names      — printed convention (ADRINEDA 1, ARENDA EXT.)
 *   §11–§14 sections    — A/B/C/D each with their own measured column set
 *   §16/§20 geometry    — 561.6pt table, intentional widths, one 1pt rule
 *   §24/§25 signatories — left/right order and the lower-band revision line
 *   §29 one page        — the form shrinks rows instead of paginating
 *
 * Pure: no database, no I/O — it renders in-memory buffers only.
 */
import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import {
  FORM_TITLE,
  DISTRITO_DEFAULT,
  LOKAL_DEFAULT,
  FORM_FOOTER,
  PDF_LAYOUT,
  FORM_LINE_WIDTH,
  FORM_LINE_COLOR,
  FORM_SHADE_COLOR,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  formatOras,
  formatDakoName,
  formatPetsaCompact,
  romanToDakoNumber,
  buildPrintedForm,
  renderWeeklySuguanPdf,
  countPdfPages,
  sectionColumnWidths,
  type PrintedForm,
  type WeeklySuguanViewModel,
} from "@/server/services/weekly-suguan-pdf.service";

const DAKO_NAMES = [
  "Adrineda I",
  "Adrineda II",
  "Pining I",
  "Pining II",
  "Arenda Extension",
  "Balete",
  "Cabatuan",
  "Dalisay",
  "Ermita",
  "Fatima",
  "Guinhalinan",
  "Hacienda",
  "Igang",
  "Jalaud",
  "Kalibo",
  "Lantawan",
  "Mabini",
  "Nabas",
  "Oton",
  "Pandan",
  "Quinapondan",
  "Roxas",
];
const TIMES = ["08:30", "09:00", "10:00", "11:30", "12:00", "13:00"];

/** A view model built directly (the builder itself is covered elsewhere). */
function vmOf(opts: {
  dakos: number;
  reserbaIi?: number;
  watermark?: "DRAFT" | null;
  petsa?: string;
  weekNo?: number;
  weekYear?: string;
}): WeeklySuguanViewModel {
  const rows = Array.from({ length: opts.dakos }, (_, i) => ({
    dakoName: DAKO_NAMES[i % DAKO_NAMES.length]!,
    oras: TIMES[i % TIMES.length]!,
    pangalan: i % 3 === 0 ? null : `Teacher ${i + 1}`,
  }));
  const reserbaIiCount = opts.reserbaIi ?? 0;
  return {
    header: {
      title: FORM_TITLE,
      distrito: DISTRITO_DEFAULT,
      lokal: LOKAL_DEFAULT,
      petsa: opts.petsa ?? "09/20/2026",
      weekNo: opts.weekNo ?? 38,
      weekYear: opts.weekYear ?? "38-2026",
    },
    sectionA: { heading: "A. SUGO", rows },
    sectionB: { heading: "B. RESERBA / RESERBA I", rows },
    sectionC:
      reserbaIiCount === 0
        ? null
        : {
            heading: "C. RESERBA II",
            rows: Array.from({ length: reserbaIiCount }, (_, i) => ({
              dakoName: DAKO_NAMES[i % DAKO_NAMES.length]!,
              oras: TIMES[i % TIMES.length]!,
              pangalan: `Reserba II ${i + 1}`,
            })),
          },
    sectionD: {
      heading: "D. MGA MAGTUTURO SA KLASE",
      rows: [
        { gampanin: "SUGO" },
        { gampanin: "SUGO" },
        { gampanin: "SUGO" },
        { gampanin: "SUGO" },
        { gampanin: "RESERBA" },
        { gampanin: "RESERBA" },
      ],
    },
    signatories: [
      { name: "NOLI JAVA", role: "PANGULONG LUPON NG PNK" },
      { name: "MCCOY SUATARON", role: "PASTOR" },
    ],
    footer: FORM_FOOTER,
    watermark: opts.watermark ?? null,
  };
}

const mediaBoxOf = (buffer: Buffer): string =>
  /\/MediaBox \[([^\]]*)\]/.exec(buffer.toString("latin1"))?.[1] ?? "MISSING";

/**
 * Every string the page actually PAINTS — the content streams inflated, then
 * every hex text operand decoded. A raw `buffer.includes("…")` would be
 * vacuous here because the streams are DEFLATE-compressed, so a heading would
 * be absent from the bytes whether or not it is drawn.
 */
function paintedText(buffer: Buffer): string {
  const latin = buffer.toString("latin1");
  const decoded: string[] = [];
  const re = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(latin)) !== null) {
    const start = match.index + match[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    let content: string;
    try {
      content = inflateSync(Buffer.from(latin.slice(start, end), "latin1")).toString("latin1");
    } catch {
      continue;
    }
    // One drawn string can be split across several show-operations (PDFKit
    // breaks on kerning), so a block's hex operands are concatenated IN ORDER.
    for (const block of content.split("BT").slice(1)) {
      const body = block.split("ET")[0] ?? block;
      let line = "";
      for (const hex of body.matchAll(/<([0-9A-Fa-f\s]{2,})>/g)) {
        const clean = hex[1]!.replace(/\s/g, "");
        for (let i = 0; i + 1 < clean.length; i += 2) {
          line += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
        }
      }
      if (line.trim()) decoded.push(line);
    }
  }
  return decoded.join("\n");
}

/**
 * Everything the renderer draws inside the table, from the printed model.
 * Section count is taken FROM the model (C is conditional), so this helper
 * cannot silently over- or under-count bands the form no longer prints.
 */
function drawnTableHeight(form: PrintedForm): number {
  const fixed =
    PDF_LAYOUT.metaRowHeight +
    form.sections.reduce(
      (height, section) => height + PDF_LAYOUT.headingBandHeight + section.headerRowHeight,
      0,
    ) +
    PDF_LAYOUT.spacerHeight +
    PDF_LAYOUT.sigSpaceHeight +
    PDF_LAYOUT.sigRoleRowHeight;
  const rows = form.sections.reduce(
    (total, section) => total + section.rows.reduce((h, r) => h + r.height, 0),
    0,
  );
  return fixed + rows;
}

const section = (form: PrintedForm, key: "A" | "B" | "C" | "D") =>
  form.sections.find((s) => s.key === key)!;

describe("weekly suguan printed form — reference layout", () => {
  // ------------------------------------------------------------- §9 times
  it("§9 prints the stored time in compact AM/PM form, never the stored HH:MM", () => {
    expect(formatOras("09:00")).toBe("9AM");
    expect(formatOras("12:00")).toBe("12PM");
    expect(formatOras("08:30")).toBe("8:30AM");
    expect(formatOras("11:30")).toBe("11:30AM");
    expect(formatOras("10:00")).toBe("10AM");
    expect(formatOras("13:00")).toBe("1PM");
    expect(formatOras("00:15")).toBe("12:15AM");
    // The stored value is never invented or approximated: anything that is not
    // a stored HH:MM prints exactly as it was stored.
    expect(formatOras("not-a-time")).toBe("not-a-time");
    expect(formatOras("25:00")).toBe("25:00");
  });

  it("§9/§10 the printed rows carry the presentation values, not the stored ones", () => {
    const a = section(buildPrintedForm(vmOf({ dakos: 4 })), "A");
    expect(a.rows[0]!.cells[0]).toBe("ADRINEDA 1"); // stored "Adrineda I"
    expect(a.rows[1]!.cells[0]).toBe("ADRINEDA 2"); // stored "Adrineda II"
    expect(a.rows[1]!.cells[1]).toBe("9AM"); // stored "09:00"
    expect(a.rows[0]!.cells[2]).toBe(""); // unassigned dako stays blank
    expect(a.rows[1]!.cells[2]).toBe("Teacher 2");
  });

  // ------------------------------------------------------- §10 dako names
  it("§10 uppercases dako names and prints numerals/Extension the reference way", () => {
    expect(formatDakoName("Adrineda I")).toBe("ADRINEDA 1");
    expect(formatDakoName("Adrineda II")).toBe("ADRINEDA 2");
    expect(formatDakoName("Pining I")).toBe("PINING 1");
    expect(formatDakoName("Pining II")).toBe("PINING 2");
    expect(formatDakoName("Arenda Extension")).toBe("ARENDA EXT.");
    expect(formatDakoName("Arenda Ext.")).toBe("ARENDA EXT.");
    expect(formatDakoName("Purok XIV")).toBe("PUROK 14");
    expect(formatDakoName("  dako   uno  ")).toBe("DAKO UNO");
  });

  it("§10 never rewrites ordinary words that merely look like numerals", () => {
    expect(romanToDakoNumber("I")).toBe("1");
    expect(romanToDakoNumber("XX")).toBe("20");
    expect(romanToDakoNumber("MIX")).toBe("MIX"); // not a canonical numeral token
    expect(romanToDakoNumber("M")).toBe("M");
    expect(romanToDakoNumber("LIV")).toBe("LIV");
    expect(romanToDakoNumber("XIVX")).toBe("XIVX");
    expect(romanToDakoNumber("XXI")).toBe("XXI"); // bounded to I–XX
    expect(formatDakoName("Villa Nova")).toBe("VILLA NOVA");
    expect(formatDakoName("Novel Dako")).toBe("NOVEL DAKO");
  });

  // -------------------------------------------------- §3/§16/§20 measured
  it("§3 the sheet is 612×936 with one 1pt rule weight and the reference's two tones", () => {
    expect([PAGE_WIDTH, PAGE_HEIGHT]).toEqual([612, 936]);
    expect(PDF_LAYOUT.pageWidth).toBe(612);
    expect(PDF_LAYOUT.pageHeight).toBe(936);
    expect(FORM_LINE_WIDTH).toBe(1);
    expect(FORM_LINE_COLOR).toBe("#595959"); // measured gray 0.349
    expect(FORM_SHADE_COLOR).toBe("#404040"); // measured gray 0.251
  });

  it("§16 the table geometry is the reference's, and every column set fills it exactly", () => {
    expect(PDF_LAYOUT.tableLeft).toBe(17.5);
    expect(PDF_LAYOUT.tableWidth).toBe(561.6);
    expect(PDF_LAYOUT.tableTop).toBe(54.3);
    expect(PDF_LAYOUT.tableBottom).toBe(872.1);
    expect(PDF_LAYOUT.tableHeight).toBeCloseTo(
      PDF_LAYOUT.tableBottom - PDF_LAYOUT.tableTop,
      6,
    );
    for (const key of ["A", "B", "C", "D"] as const) {
      const widths = sectionColumnWidths(key);
      expect(widths.reduce((a, b) => a + b, 0), key).toBeCloseTo(PDF_LAYOUT.tableWidth, 6);
      expect(new Set(widths).size, key).toBeGreaterThan(1); // never equal-width
    }
    // A/B/C share one grid (the reference's measured DAKO/ORAS/PANGALAN widths,
    // with the reference's sixth PAGTUPAD column deliberately REMOVED and its
    // freed 70.5pt split evenly between the two remaining annotation columns);
    // D has its own four fields.
    expect(sectionColumnWidths("A")).toEqual([81.6, 49.8, 162.5, 133.85, 133.85]);
    expect(sectionColumnWidths("A")).toEqual(sectionColumnWidths("B"));
    expect(sectionColumnWidths("C")).toEqual(sectionColumnWidths("A"));
    expect(sectionColumnWidths("D")).toEqual([81.6, 212.3, 145.7, 122]);
  });

  it("§16 PAGTUPAD is not printed anywhere and PAGTANGGAP/PAGBABAGO are balanced", () => {
    const form = buildPrintedForm(vmOf({ dakos: 3, reserbaIi: 2 }));
    const labels = form.sections.flatMap((s) => s.columns.map((c) => c.label));
    expect(labels).not.toContain("PAGTUPAD");
    for (const key of ["A", "B", "C"] as const) {
      expect(section(form, key).columns.map((c) => c.key)).toEqual([
        "dako",
        "oras",
        "pangalan",
        "pagtanggap",
        "pagbabago",
      ]);
    }
    // Balanced: the reference's PAGTANGGAP + PAGTUPAD + PAGBABAGO width
    // (75.2 + 70.5 + 122 = 267.7pt) is now shared evenly by two columns.
    const widths = sectionColumnWidths("A");
    expect(widths[3]).toBe(widths[4]);
    expect(widths[3]).toBeCloseTo((75.2 + 70.5 + 122) / 2, 6);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(PDF_LAYOUT.tableWidth, 6);
  });

  it("§9/§31 the reference's printed values are all valid ASCII (no glyph fallback)", () => {
    const form = buildPrintedForm(vmOf({ dakos: 22, reserbaIi: 5 }));
    const strings = [
      form.title,
      form.footer,
      ...form.meta.map((c) => c.text),
      ...form.sections.flatMap((s) => [s.heading, ...s.columns.map((c) => c.label)]),
      ...form.sections.flatMap((s) => s.rows.flatMap((r) => r.cells)),
      ...form.signatories.flatMap((s) => [s.name, s.role]),
    ];
    for (const value of strings) {
      expect(value, value).toMatch(/^[\x20-\x7E]*$/);
    }
  });

  // --------------------------------------------------------- §8 metadata
  it("§8 prints eight alternating label/value cells with the MM/DD/YY date", () => {
    const form = buildPrintedForm(vmOf({ dakos: 1 }));
    expect(form.meta.map((c) => c.text)).toEqual([
      "DISTRITO",
      "MME",
      "LOKAL",
      "ILUGIN",
      "PETSA",
      "09/20/26",
      "WEEK NO.",
      "38",
    ]);
    expect(form.meta.reduce((sum, c) => sum + c.width, 0)).toBeCloseTo(PDF_LAYOUT.tableWidth, 6);
    // labels are the small runs, values the large ones (measured)
    expect(form.meta.filter((c) => !c.bold).every((c) => c.size === PDF_LAYOUT.metaLabelSize)).toBe(true);
    expect(form.meta.filter((c) => c.bold).every((c) => c.size === PDF_LAYOUT.metaValueSize)).toBe(true);
    expect(formatPetsaCompact("09/20/2026")).toBe("09/20/26");
    expect(formatPetsaCompact("01/03/2021")).toBe("01/03/21");
    expect(formatPetsaCompact("unexpected")).toBe("unexpected");
  });

  it("§8 the metadata row height is the reference's 26.2pt band", () => {
    expect(PDF_LAYOUT.metaRowHeight).toBeCloseTo(26.23, 2);
    expect(buildPrintedForm(vmOf({ dakos: 1 })).metaRowHeight).toBe(PDF_LAYOUT.metaRowHeight);
  });

  // ------------------------------------------------ §11–§14 the sections
  it("§13 RESERBA II prints ONLY when a teacher is assigned as RESERBA II", () => {
    const withoutC = buildPrintedForm(vmOf({ dakos: 3 })); // view-model C is null
    expect(withoutC.sections.map((s) => s.key)).toEqual(["A", "B", "D"]);
    expect(withoutC.sections.some((s) => s.key === "C")).toBe(false);

    const withC = buildPrintedForm(vmOf({ dakos: 3, reserbaIi: 1 }));
    expect(withC.sections.map((s) => s.key)).toEqual(["A", "B", "C", "D"]);
    const c = section(withC, "C");
    expect(c.heading).toBe("C. RESERBA II");
    expect(c.columns.map((col) => col.label)).toEqual([
      "DAKO",
      "ORAS",
      "PANGALAN",
      "PAGTANGGAP",
      "PAGBABAGO",
    ]);
    // The block keeps the reference's five-row height: the assigned row(s), then
    // blank form rows — never invented data, and never fewer rows than the form.
    expect(c.rows.length).toBe(PDF_LAYOUT.cMinRows);
    expect(c.rows[0]!.cells[0]).not.toBe("");
    expect(c.rows.filter((r) => r.cells[0] === "")).toHaveLength(PDF_LAYOUT.cMinRows - 1);

    // The absent section frees its bands back to the row budget.
    expect(drawnTableHeight(withC)).toBeGreaterThan(drawnTableHeight(withoutC));
  });

  it("§13 the rendered PAGE follows the same rule — C is painted only with RESERBA II data", async () => {
    const withoutC = await renderWeeklySuguanPdf(vmOf({ dakos: 3 }));
    const withC = await renderWeeklySuguanPdf(vmOf({ dakos: 3, reserbaIi: 1 }));
    expect(countPdfPages(withoutC)).toBe(1);
    expect(countPdfPages(withC)).toBe(1);

    // Painted text, decoded from the inflated content streams (not raw bytes).
    const withoutText = paintedText(withoutC);
    const withText = paintedText(withC);
    expect(withText).toContain("C. RESERBA II"); // the real control case
    expect(withText).toContain("PAGBABAGO");
    expect(withoutText).not.toContain("RESERBA II");
    // A and D are unaffected by C's absence.
    expect(withoutText).toContain("A. SUGO");
    expect(withoutText).toContain("D. MGA MAGTUTURO SA KLASE");
  });

  it("§11/§12/§14 each section keeps its own column set and blank annotation areas", () => {
    const form = buildPrintedForm(vmOf({ dakos: 2, reserbaIi: 1 }));
    expect(section(form, "A").columns.map((c) => c.label)).toEqual([
      "DAKO",
      "ORAS",
      "PANGALAN",
      "PAGTANGGAP",
      "PAGBABAGO",
    ]);
    expect(section(form, "B").columns.map((c) => c.label)).toEqual(
      section(form, "A").columns.map((c) => c.label),
    );
    expect(section(form, "D").columns.map((c) => c.label)).toEqual([
      "GAMPANIN",
      "PANGALAN",
      "LAGDA",
      "PANSIN",
    ]);
    // PAGTANGGAP / PAGBABAGO stay blank (physical annotation areas), and a row
    // carries exactly one cell per printed column — no orphaned extra cell.
    for (const row of section(form, "A").rows) {
      expect(row.cells).toHaveLength(5);
      expect(row.cells[3]).toBe("");
      expect(row.cells[4]).toBe("");
    }
  });

  it("§14 section D prints four SUGO rows, the reference's blank row, then RESERBA", () => {
    const d = section(buildPrintedForm(vmOf({ dakos: 2 })), "D");
    expect(d.rows).toHaveLength(7);
    expect(d.rows.map((r) => r.cells[0])).toEqual([
      "SUGO",
      "SUGO",
      "SUGO",
      "SUGO",
      "",
      "RESERBA",
      "RESERBA",
    ]);
  });

  it("§18/§31 alignment and weight are semantic, per column", () => {
    const a = section(buildPrintedForm(vmOf({ dakos: 2, reserbaIi: 1 })), "A");
    expect(a.columns.map((c) => c.dataAlign)).toEqual([
      "left",
      "left",
      "left",
      "center",
      "center",
    ]);
    // the reference prints names bold and times regular
    expect(a.columns.map((c) => c.dataBold)).toEqual([true, false, true, true, true]);
    const d = section(buildPrintedForm(vmOf({ dakos: 2 })), "D");
    expect(d.columns.map((c) => c.dataAlign)).toEqual(["left", "left", "center", "center"]);
  });

  // ------------------------------------------------------ §24/§25 blocks
  it("§24/§25 keep the signature order and put the revision line below the table", () => {
    const form = buildPrintedForm(vmOf({ dakos: 2 }));
    expect(form.signatories.map((s) => s.name)).toEqual(["NOLI JAVA", "MCCOY SUATARON"]);
    expect(form.signatories.map((s) => s.role)).toEqual(["PANGULONG LUPON NG PNK", "PASTOR"]);
    expect(form.footer).toBe(FORM_FOOTER);
    // §25 — the reference prints the revision line BELOW the table, not inside.
    expect(PDF_LAYOUT.footerBaseline).toBeGreaterThan(PDF_LAYOUT.tableBottom);
    expect(PDF_LAYOUT.footerBaseline).toBeLessThan(PAGE_HEIGHT);
    expect(PDF_LAYOUT.sigSplit).toBe(311.4);
  });

  // ---------------------------------------------------------- §29 one page
  it("§29 renders EXACTLY one 612×936 page at 2, 11, 22 and 40 dakos", async () => {
    for (const dakos of [2, 11, 22, 40]) {
      const vm = vmOf({ dakos, reserbaIi: dakos >= 11 ? 5 : 0 });
      const form = buildPrintedForm(vm);
      const buffer = await renderWeeklySuguanPdf(vm);
      expect(countPdfPages(buffer), `dakos=${dakos}`).toBe(1);
      expect(mediaBoxOf(buffer), `dakos=${dakos}`).toBe("0 0 612 936");
      expect(buffer.subarray(0, 4).toString(), `dakos=${dakos}`).toBe("%PDF");
      // The rows physically fit the sheet: the form shrinks instead of paginating.
      expect(form.fitsAvailableHeight, `dakos=${dakos}`).toBe(true);
      expect(form.bodyRowHeight, `dakos=${dakos}`).toBeGreaterThanOrEqual(PDF_LAYOUT.rowFloorH);
      expect(form.bodyRowHeight, `dakos=${dakos}`).toBeLessThanOrEqual(PDF_LAYOUT.bodyRowHeight);
      expect(drawnTableHeight(form), `dakos=${dakos}`).toBeLessThanOrEqual(
        PDF_LAYOUT.tableHeight + 0.01,
      );
      expect(form.cellSize).toBe(PDF_LAYOUT.cellSize);
    }
  });

  it("§33 a week shaped like the reference reproduces its measured row pitch exactly", () => {
    // 11 dakos, a RESERBA II teacher (so C prints, as it does on the filled-in
    // reference form), 4 SUGO + 2 RESERBA in D — the reference's own shape lands
    // on the reference's own 16.2pt pitch and fills the table.
    const form = buildPrintedForm(vmOf({ dakos: 11, reserbaIi: 1 }));
    expect(form.bodyRowHeight).toBe(16.2);
    expect(section(form, "C").rows).toHaveLength(5);
    expect(section(form, "D").rows).toHaveLength(7);
    const drawn = drawnTableHeight(form);
    expect(drawn).toBeLessThanOrEqual(PDF_LAYOUT.tableHeight);
    expect(PDF_LAYOUT.tableHeight - drawn).toBeLessThan(0.5); // the reference's own fit
  });

  it("§29 dense weeks shrink the rows before the page count changes", () => {
    const sparse = buildPrintedForm(vmOf({ dakos: 2 }));
    const dense = buildPrintedForm(vmOf({ dakos: 22, reserbaIi: 5 }));
    expect(sparse.bodyRowHeight).toBe(PDF_LAYOUT.bodyRowHeight); // capped, never stretched
    expect(dense.bodyRowHeight).toBeLessThan(sparse.bodyRowHeight);
    expect(dense.bodyRowHeight).toBeGreaterThanOrEqual(PDF_LAYOUT.rowFloorH);
  });

  // ------------------------------------------------------ §26 status chrome
  it("§26 DRAFT stays a watermark flag and never becomes form chrome", () => {
    expect(buildPrintedForm(vmOf({ dakos: 2 })).watermark).toBeNull();
    expect(buildPrintedForm(vmOf({ dakos: 2, watermark: "DRAFT" })).watermark).toBe("DRAFT");
  });

  // ------------------------------------------------ §17/§29 the fit is honest
  it("§17/§29 the drawn table always fits the table box and the flag agrees", () => {
    for (const dakos of [2, 11, 22]) {
      const form = buildPrintedForm(vmOf({ dakos, reserbaIi: 5 }));
      expect(drawnTableHeight(form), `dakos=${dakos}`).toBeLessThanOrEqual(
        PDF_LAYOUT.tableHeight + 0.01,
      );
      expect(form.fitsAvailableHeight, `dakos=${dakos}`).toBe(true);
      expect(form.sections.every((s) => s.rows.every((r) => r.height === form.bodyRowHeight))).toBe(
        true,
      );
    }
  });
});
