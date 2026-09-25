/**
 * Phase 7 — Weekly Suguan physical-form PDF (READ-ONLY output layer).
 *
 * Two strictly separated halves:
 *   1. buildWeeklySuguanViewModel(weekId) — assembles the form data from the
 *      EXISTING weekly assignment source of truth
 *      (AssignmentService.listAssignmentsForWeek) plus ACTIVE dako master
 *      rows. Contains ZERO scheduling logic: no eligibility, fairness,
 *      allocation, language, prev-week-absence or replacement rules — it only
 *      reads the resulting schedule. Never writes anything.
 *   2. renderWeeklySuguanPdf(vm) — pure pdfkit rendering of the view model;
 *      no DB access. Layout constants are isolated at the top so visual
 *      tuning against the physical reference form is trivial later.
 */
import PDFDocument from "pdfkit";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { dako, weeks } from "@/server/db/schema";
import { isoWeekDates } from "@/lib/iso-week";
import { NotFoundError } from "@/lib/errors";
import { isNormalSchedulingWeek } from "@/server/config";
import { listAssignmentsForWeek } from "./assignment.service";
import { listMagtuturoForWeek } from "./magtuturo.service";
import {
  renderSuguanSlipPages,
  type SuguanSlip,
  type SuguanSlipContext,
} from "./suguan-slip-pdf.service";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export const FORM_TITLE = "SUGUAN NG MGA GURO SA PAGSAMBA NG KABATAAN";
export const DISTRITO_DEFAULT = "MME";
export const LOKAL_DEFAULT = "ILUGIN";
export const FORM_FOOTER = "Revised September 2026";

export interface SuguanFormRow {
  dakoName: string;
  oras: string;
  pangalan: string | null; // blank when unassigned — never invented
}

export interface SuguanFormSignatory {
  name: string;
  role: string;
}

export interface WeeklySuguanViewModel {
  header: {
    title: string;
    distrito: string;
    lokal: string;
    /** Sunday of the selected ISO week, MM/DD/YYYY — never the generation date. */
    petsa: string;
    weekNo: number;
    /**
     * `<ISO week number>-<stored year>` of the SELECTED week — e.g. `36-2026`.
     * Read from the weeks row itself: never `new Date()`, never the date the PDF
     * happens to be generated, never a literal. Printed as the appended Patotoo
     * slips' "Week - Year" value, identically on both copies.
     */
    weekYear: string;
  };
  sectionA: { heading: string; rows: SuguanFormRow[] }; // ALL ACTIVE dakos
  sectionB: { heading: string; rows: SuguanFormRow[] }; // ALL APPLICABLE dakos (see dakoInclusion)
  /** null ⇔ zero RESERBA_II assignments ⇒ section C omitted entirely. */
  sectionC: { heading: string; rows: SuguanFormRow[] } | null;
  /** Update #21.13 — rows carry the Magtuturo teacher name (PANGALAN col). */
  sectionD: { heading: string; rows: { gampanin: string; pangalan: string | null }[] }; // 4 SUGO + 2 RESERBA
  signatories: SuguanFormSignatory[];
  footer: string;
  /** DRAFT renders a diagonal watermark; FINALIZED/PUBLISHED render clean. */
  watermark: "DRAFT" | null;
}

/** MM/DD/YYYY in UTC — deterministic for the ISO week. */
function formatPetsa(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
}

/**
 * Assemble the physical-form data for one ISO week. Three set-based reads,
 * zero writes (§ no N+1). Ordering is deterministic (dakoCode, then name) —
 * never raw DB return order.
 */
export async function buildWeeklySuguanViewModel(weekId: string): Promise<WeeklySuguanViewModel> {
  const db = getDb();
  const [weekRow] = await db.select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
  if (!weekRow) throw new NotFoundError("week not found");

  // Guard: the weeks row must agree with ISO math (52/53-safe Sunday calc).
  const { endDate } = isoWeekDates(weekRow.year, weekRow.isoWeekNumber);

  // §43 / clarification #9 — applicable-dako determination.
  //  • Normal operational weeks (≥ SCHEDULING_GO_LIVE): ALL currently ACTIVE dakos.
  //  • Historical weeks (< go-live): only dakos whose active status for that
  //    week can be reliably determined from RECORDED master facts — include a
  //    DISABLED dako only when a recorded date_disabled is AFTER the week's
  //    end date (proof it was active that week). When indeterminate, the
  //    conservative current-rule fallback applies. Historical status is NEVER
  //    invented and no fake status records are created for rendering.
  const [allDakos, assignments] = await Promise.all([
    db
      .select({
        id: dako.id,
        name: dako.name,
        dakoCode: dako.dakoCode,
        worshipTime: dako.worshipTime,
        status: dako.status,
        dateDisabled: dako.dateDisabled,
      })
      .from(dako),
    listAssignmentsForWeek(weekId),
  ]);

  const isHistoricalWeek = !isNormalSchedulingWeek(weekRow.year, weekRow.isoWeekNumber);
  const applicable = allDakos.filter((d) => {
    if (d.status === "ACTIVE") return true;
    if (!isHistoricalWeek) return false; // normal week: currently ACTIVE only
    return d.dateDisabled !== null && d.dateDisabled > endDate; // recorded fact
  });

  // Deterministic order consistent with master-data convention.
  const ordered = [...applicable].sort(
    (a, b) => a.dakoCode.localeCompare(b.dakoCode) || a.name.localeCompare(b.name),
  );

  // assignmentType → dakoId → teacherName (only rows that hold a teacher).
  const byType = new Map<string, Map<string, string>>();
  for (const a of assignments) {
    if (!a.teacherId || a.status !== "ASSIGNED") continue;
    let m = byType.get(a.assignmentType);
    if (!m) {
      m = new Map();
      byType.set(a.assignmentType, m);
    }
    if (!m.has(a.dakoId)) m.set(a.dakoId, a.teacherName);
  }

  const mkRows = (type: string): SuguanFormRow[] =>
    ordered.map((d) => ({
      dakoName: d.name,
      oras: d.worshipTime,
      pangalan: byType.get(type)?.get(d.id) ?? null,
      dakoStatusAt: d.status === "ACTIVE" ? ("ACTIVE" as const) : ("DISABLED" as const),
    }));

  // Update #21.13 — section D PANGALAN comes from the real Magtuturo records
  // (4 SUGO seats then 2 RESERBA seats, same order as gampanin). One extra
  // set-based read of the SAME authoritative source the Magtuturo page shows.
  const magtuturo = await listMagtuturoForWeek(weekId);
  const magSugo = magtuturo.filter((m) => m.magType === "SUGO").sort((x, y) => x.seat - y.seat);
  const magReserba = magtuturo.filter((m) => m.magType === "RESERBA").sort((x, y) => x.seat - y.seat);

  const sugo = mkRows("SUGO");
  const reserba = mkRows("RESERBA");
  const reserbaIiRows = mkRows("RESERBA_II").filter((r) => r.pangalan !== null);

  return {
    header: {
      title: FORM_TITLE,
      distrito: DISTRITO_DEFAULT,
      lokal: LOKAL_DEFAULT,
      petsa: formatPetsa(endDate),
      weekNo: weekRow.isoWeekNumber,
      weekYear: `${weekRow.isoWeekNumber}-${weekRow.year}`,
    },
    sectionA: { heading: "A. SUGO", rows: sugo },
    sectionB: { heading: "B. RESERBA / RESERBA I", rows: reserba },
    sectionC: reserbaIiRows.length === 0 ? null : { heading: "C. RESERBA II", rows: reserbaIiRows },
    sectionD: {
      heading: "D. MGA MAGTUTURO SA KLASE",
      rows: [
        { gampanin: "SUGO", pangalan: magSugo[0]?.teacherName ?? null },
        { gampanin: "SUGO", pangalan: magSugo[1]?.teacherName ?? null },
        { gampanin: "SUGO", pangalan: magSugo[2]?.teacherName ?? null },
        { gampanin: "SUGO", pangalan: magSugo[3]?.teacherName ?? null },
        { gampanin: "RESERBA", pangalan: magReserba[0]?.teacherName ?? null },
        { gampanin: "RESERBA", pangalan: magReserba[1]?.teacherName ?? null },
      ],
    },
    signatories: [
      { name: "NOLI JAVA", role: "PANGULONG LUPON NG PNK" },
      { name: "MCCOY SUATARON", role: "PASTOR" },
    ],
    footer: FORM_FOOTER,
    watermark: weekRow.status === "DRAFT" ? "DRAFT" : null,
  };
}

// ---------------------------------------------------------------------------
// Renderer (pure — receives the view model, touches nothing else)
//
// CALIBRATED AGAINST THE PHYSICAL REFERENCE FORM (Sugo.pdf) by measuring the
// reference itself — its page geometry, rule positions, cell shading, per-run
// fonts/sizes and text baselines — rather than approximating it:
//   • 612 × 936pt sheet; the form's ONLY boundary is a single bordered table
//     (there is no page frame); 1pt rules in 35% grey; 25%-black shaded
//     column-header rows; a 26.2pt row of eight label/value cells; 27.6pt
//     section-heading bands; 16.2pt body rows (shrunk only when a week is too
//     dense to hold the one-page rule); the revision line BELOW the table.
//   • §28 — explicit coordinates driving named draw functions; the form's
//     layout is fixed, never decided by a generic auto-flowing table.
//   • PRESENTATION-ONLY formatters (§9, §10): the stored HH:MM time and the
//     stored dako name are never changed in the database — only what a cell
//     PRINTS is converted (09:00 → 9AM, “Adrineda I” → ADRINEDA 1).
//   • Core PDFKit fonts only, standing in for the reference's Calibri /
//     Verdana / Arial at the measured sizes — no external font dependency.
// ---------------------------------------------------------------------------

/** §3 — the physical sheet: 8.5 × 13 in PORTRAIT. Never Letter/A4/Legal. */
export const PAGE_WIDTH = 612; // 8.5in × 72
export const PAGE_HEIGHT = 936; // 13in × 72

/** §20 — the reference draws every form line as a 1pt 35%-grey rule. */
export const FORM_LINE_WIDTH = 1;
export const FORM_LINE_COLOR = "#595959"; // the reference's gray 0.349
/** The reference shades its column-header rows with 25% black. */
export const FORM_SHADE_COLOR = "#404040"; // gray 0.251
export const FORM_HEADER_TEXT = "#ffffff";
export const FORM_TEXT_COLOR = "#000000";
export const FORM_MUTED_TEXT = "#595959";

/**
 * §16 — every coordinate and column width in ONE place, all values measured
 * from the reference form. Column sets are intentionally NOT equal-width and
 * each sums EXACTLY to the table width (asserted by test).
 */
export const PDF_LAYOUT = {
  pageWidth: PAGE_WIDTH,
  pageHeight: PAGE_HEIGHT,

  // §23 — the printed table IS the form boundary. The reference draws no page
  // frame and does not centre the table (≈17.5pt left, ≈33pt right).
  tableLeft: 17.5,
  tableWidth: 561.6,
  tableTop: 54.3,
  tableBottom: 872.1,
  tableHeight: 817.8,

  // §7 — title band, above the table, centred on the TABLE (not the page).
  // The reference prints it in Verdana-Bold 14 — a wider face than the core
  // font standing in for it, so the size is set to reproduce the reference's
  // PRINTED width (≈408pt) rather than its nominal point size.
  titleSize: 15,
  titleBaseline: 37.8,

  // §8 — one 26.2pt row of eight alternating label/value cells.
  metaRowHeight: 26.23,
  metaLabelSize: 11,
  metaValueSize: 14,
  metaCellWidths: [81.6, 49.8, 62.3, 100.2, 75.2, 70.5, 72.2, 49.8] as const,

  // §11–§14 — heading bands, header rows and body rows.
  headingBandHeight: 27.6,
  headingSize: 11,
  /** left inset of a section heading from the table border (measured) */
  headingInset: 24.1,
  abHeaderRowHeight: 16.2,
  cdHeaderRowHeight: 14.4,
  headerSize: 9,
  /** the reference's body-row pitch — used whenever the week fits */
  bodyRowHeight: 16.2,
  rowFloorH: 4,
  cellSize: 10,
  /** left inset of a data cell from its column's left rule (measured) */
  cellPadX: 9.1,
  /**
   * The reference's C block is five rows tall. Kept as a FLOOR when C prints,
   * so the block has the form's height even with one or two RESERBA II rows;
   * it is no longer a reason to print C at all — see `printsSectionC`.
   */
  cMinRows: 5,
  /** §14 — D prints four SUGO rows, the reference's blank row, then RESERBA */
  dSugoRows: 4,
  /** full-width blank row between section D and the signature band (measured) */
  spacerHeight: 12,

  // §24 — signature band: a blank signing space whose bottom line carries the
  // name, then the role row. Split at the section grid's mid boundary — an
  // ABSOLUTE x, the same one the reference uses for its PANGALAN/PAGTANGGAP
  // column edge (widths are derived from it).
  sigSplit: 311.4,
  sigSpaceHeight: 42.59,
  sigRoleRowHeight: 14.43,
  sigNameSize: 12,
  sigRoleSize: 11,
  /** the name sits on the space row's bottom line, as printed */
  sigNameBottomPad: 3.9,

  // §25 — revision line below the table.
  footerSize: 11,
  footerLeft: 18,
  footerBaseline: 908.6,
} as const;

export type ColumnAlign = "left" | "center";

/** One printed column: fixed measured width, its own header and alignment. */
export interface FormColumn {
  key: string;
  label: string;
  width: number;
  /** §18 — data-cell alignment; every HEADER is centred, as measured */
  dataAlign: ColumnAlign;
  /** the reference prints dako/teacher names bold and times regular */
  dataBold: boolean;
}

/**
 * A/B/C share one grid. The DAKO/ORAS/PANGALAN widths are the reference's
 * measured values (561.6pt table): 81.6 / 49.8 / 162.5.
 *
 * REVISION (user-directed, over the measured reference): the reference prints a
 * sixth PAGTUPAD column between PAGTANGGAP and PAGBABAGO. It is deliberately
 * REMOVED, and the three annotation/sign-off columns it formed are replaced by
 * TWO balanced ones: the combined width of the reference's PAGTANGGAP (75.2) +
 * PAGTUPAD (70.5) + PAGBABAGO (122) = 267.7pt is split evenly, so PAGTANGGAP
 * and PAGBABAGO print at 133.85pt each. Column count and those two widths are
 * the ONLY departure from the measured form; every other coordinate is
 * unchanged. This is a
 * PRESENTATION change only — no stored value, rule or annotation meaning moves.
 */
export const AB_COLUMNS: readonly FormColumn[] = [
  { key: "dako", label: "DAKO", width: 81.6, dataAlign: "left", dataBold: true },
  { key: "oras", label: "ORAS", width: 49.8, dataAlign: "left", dataBold: false },
  { key: "pangalan", label: "PANGALAN", width: 162.5, dataAlign: "left", dataBold: true },
  { key: "pagtanggap", label: "PAGTANGGAP", width: 133.85, dataAlign: "center", dataBold: true },
  { key: "pagbabago", label: "PAGBABAGO", width: 133.85, dataAlign: "center", dataBold: true },
];

/** §13 — C prints the same column set as A and B. */
const C_COLUMNS: readonly FormColumn[] = AB_COLUMNS;

/** §14 — D has its own four fields (measured: 561.6pt). */
export const D_COLUMNS: readonly FormColumn[] = [
  { key: "gampanin", label: "GAMPANIN", width: 81.6, dataAlign: "left", dataBold: true },
  { key: "pangalan", label: "PANGALAN", width: 212.3, dataAlign: "left", dataBold: true },
  { key: "lagda", label: "LAGDA", width: 145.7, dataAlign: "center", dataBold: true },
  { key: "pansin", label: "PANSIN", width: 122, dataAlign: "center", dataBold: true },
];

/**
 * Measured column widths for a section. Kept exported so the layout contract
 * stays testable without rendering.
 */
export function sectionColumnWidths(section: "A" | "B" | "C" | "D"): number[] {
  const columns = section === "D" ? D_COLUMNS : section === "C" ? C_COLUMNS : AB_COLUMNS;
  return columns.map((c) => c.width);
}

// ---------------------------------------------------------------------------
// §9 / §10 — presentation-only formatters (stored data is never touched)
// ---------------------------------------------------------------------------

/**
 * §9 — stored 24-hour "HH:MM" → the reference's compact AM/PM presentation:
 * 09:00 → 9AM, 12:00 → 12PM, 08:30 → 8:30AM, 11:30 → 11:30AM, 13:00 → 1PM.
 * An unparseable value is passed through untouched rather than invented.
 */
export function formatOras(stored: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(stored.trim());
  if (!m) return stored;
  const h24 = Number(m[1]);
  const minutes = Number(m[2]);
  if (h24 > 23 || minutes > 59) return stored;
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return minutes === 0 ? `${h12}${suffix}` : `${h12}:${String(minutes).padStart(2, "0")}${suffix}`;
}

/**
 * Canonical Roman numerals only, bounded to I–XX. Matching whole tokens means
 * ordinary names that merely contain roman letters (MIX, LIV, Villa Nova) are
 * never mangled.
 */
const ROMAN_TOKENS: Record<string, number> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10,
  XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16, XVII: 17, XVIII: 18, XIX: 19, XX: 20,
};

/** "II" → "2"; a token that is not a canonical Roman numeral is returned as-is. */
export function romanToDakoNumber(token: string): string {
  const value = ROMAN_TOKENS[token.toUpperCase()];
  return value === undefined ? token : String(value);
}

/**
 * §10 — the reference's printed convention for a dako name: uppercase, Arabic
 * numerals for a trailing Roman number, abbreviated "EXT.". Database values
 * are never modified — only what the form prints.
 * "Adrineda I" → "ADRINEDA 1", "Pining II" → "PINING 2", "Arenda Extension" → "ARENDA EXT."
 */
export function formatDakoName(stored: string): string {
  return stored
    .toUpperCase()
    .replace(/\b(?:EXTENSION|EXT)\b\.?/g, "EXT.")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => romanToDakoNumber(token))
    .join(" ");
}

/** §8 — MM/DD/YYYY → the reference's compact MM/DD/YY printed date. */
export function formatPetsaCompact(petsa: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(petsa);
  return m ? `${m[1]}/${m[2]}/${m[3]!.slice(2)}` : petsa;
}

// ---------------------------------------------------------------------------
// Printed form model — the view model resolved into exactly what gets drawn
// ---------------------------------------------------------------------------

export interface PrintedMetaCell {
  text: string;
  width: number;
  size: number;
  bold: boolean;
}

export interface PrintedRow {
  cells: string[];
  height: number;
}

export interface PrintedSection {
  key: "A" | "B" | "C" | "D";
  heading: string;
  columns: readonly FormColumn[];
  headerRowHeight: number;
  rows: PrintedRow[];
}

export interface PrintedForm {
  title: string;
  metaRowHeight: number;
  meta: PrintedMetaCell[];
  sections: PrintedSection[];
  spacerHeight: number;
  signatories: { name: string; role: string }[];
  footer: string;
  watermark: "DRAFT" | null;
  /** §29 — the row pitch actually used (16.2pt unless the week is too dense) */
  bodyRowHeight: number;
  cellSize: number;
  /** §29 — true when every row + band fits inside the table at that pitch */
  fitsAvailableHeight: boolean;
}

/**
 * Resolve the view model into the printed form: which sections print, their
 * rows, the row pitch, and every string EXACTLY as it appears on paper.
 * Pure — no pdfkit, no I/O — so §30's checks are testable without rendering.
 */
export function buildPrintedForm(vm: WeeklySuguanViewModel): PrintedForm {
  const dSugoRows = Math.min(vm.sectionD.rows.length, PDF_LAYOUT.dSugoRows);
  const dTailRows = Math.max(0, vm.sectionD.rows.length - dSugoRows);
  const dPrintedCount = dSugoRows + 1 + dTailRows; // four SUGO, the blank row, the rest

  // §13 (revised) — RESERBA II is printed ONLY for a week that actually has a
  // teacher assigned as RESERBA II, which the view model exposes as a non-null
  // sectionC. With none, the section is absent from the form entirely: no
  // heading, no column-header row, no blank shell. The form follows the data
  // here rather than reserving space for a category the week does not use.
  const printsSectionC = vm.sectionC !== null;
  const cBodyCount = printsSectionC
    ? Math.max(vm.sectionC!.rows.length, PDF_LAYOUT.cMinRows)
    : 0;
  const bodyRowCount =
    vm.sectionA.rows.length + vm.sectionB.rows.length + cBodyCount + dPrintedCount;

  const fixedHeight =
    PDF_LAYOUT.metaRowHeight +
    PDF_LAYOUT.headingBandHeight * (printsSectionC ? 4 : 3) +
    PDF_LAYOUT.abHeaderRowHeight * 2 +
    PDF_LAYOUT.cdHeaderRowHeight * (printsSectionC ? 2 : 1) +
    PDF_LAYOUT.spacerHeight +
    PDF_LAYOUT.sigSpaceHeight +
    PDF_LAYOUT.sigRoleRowHeight;
  const available = PDF_LAYOUT.tableHeight - fixedHeight;
  const share = available / Math.max(bodyRowCount, 1);
  const bodyRowHeight = Math.max(
    PDF_LAYOUT.rowFloorH,
    Math.min(PDF_LAYOUT.bodyRowHeight, Math.floor(share * 100) / 100),
  );
  const totalHeight = fixedHeight + bodyRowCount * bodyRowHeight;

  const row = (cells: string[]): PrintedRow => ({ cells, height: bodyRowHeight });
  // §15 — PAGTANGGAP / PAGBABAGO are ALWAYS blank: they are the form's physical
  // annotation areas, filled in by hand on paper, never from data.
  const abRows = (rows: SuguanFormRow[]): PrintedRow[] =>
    rows.map((r) =>
      row([formatDakoName(r.dakoName), formatOras(r.oras), r.pangalan ?? "", "", ""]),
    );

  // Only ever drawn when C prints, i.e. when at least one RESERBA II teacher
  // exists; the block then keeps the reference's five-row height.
  const cRows: PrintedRow[] = [
    ...abRows(vm.sectionC?.rows ?? []),
    ...Array.from({ length: cBodyCount - (vm.sectionC?.rows.length ?? 0) }, () =>
      row(["", "", "", "", ""]),
    ),
  ];

  const dRows: PrintedRow[] = [
    ...vm.sectionD.rows.slice(0, dSugoRows).map((r) => row([r.gampanin, r.pangalan ?? "", "", ""])),
    // the reference prints a blank row between the SUGO and RESERBA blocks
    row(["", "", "", ""]),
    ...vm.sectionD.rows.slice(dSugoRows).map((r) => row([r.gampanin, r.pangalan ?? "", "", ""])),
  ];

  const [w0, w1, w2, w3, w4, w5, w6, w7] = PDF_LAYOUT.metaCellWidths;
  const meta: PrintedMetaCell[] = [
    { text: "DISTRITO", width: w0, size: PDF_LAYOUT.metaLabelSize, bold: false },
    { text: vm.header.distrito, width: w1, size: PDF_LAYOUT.metaValueSize, bold: true },
    { text: "LOKAL", width: w2, size: PDF_LAYOUT.metaLabelSize, bold: false },
    { text: vm.header.lokal, width: w3, size: PDF_LAYOUT.metaValueSize, bold: true },
    { text: "PETSA", width: w4, size: PDF_LAYOUT.metaLabelSize, bold: false },
    { text: formatPetsaCompact(vm.header.petsa), width: w5, size: PDF_LAYOUT.metaValueSize, bold: true },
    { text: "WEEK NO.", width: w6, size: PDF_LAYOUT.metaLabelSize, bold: false },
    { text: String(vm.header.weekNo), width: w7, size: PDF_LAYOUT.metaValueSize, bold: true },
  ];

  return {
    title: vm.header.title,
    metaRowHeight: PDF_LAYOUT.metaRowHeight,
    meta,
    sections: [
      {
        key: "A",
        heading: vm.sectionA.heading,
        columns: AB_COLUMNS,
        headerRowHeight: PDF_LAYOUT.abHeaderRowHeight,
        rows: abRows(vm.sectionA.rows),
      },
      {
        key: "B",
        heading: vm.sectionB.heading,
        columns: AB_COLUMNS,
        headerRowHeight: PDF_LAYOUT.abHeaderRowHeight,
        rows: abRows(vm.sectionB.rows),
      },
      ...(printsSectionC
        ? [
            {
              key: "C" as const,
              heading: vm.sectionC!.heading,
              columns: C_COLUMNS,
              headerRowHeight: PDF_LAYOUT.cdHeaderRowHeight,
              rows: cRows,
            },
          ]
        : []),
      {
        key: "D",
        heading: vm.sectionD.heading,
        columns: D_COLUMNS,
        headerRowHeight: PDF_LAYOUT.cdHeaderRowHeight,
        rows: dRows,
      },
    ],
    spacerHeight: PDF_LAYOUT.spacerHeight,
    signatories: vm.signatories,
    footer: vm.footer,
    watermark: vm.watermark,
    bodyRowHeight,
    cellSize: PDF_LAYOUT.cellSize,
    fitsAvailableHeight: totalHeight <= PDF_LAYOUT.tableHeight + 0.01,
  };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Helvetica ascender (0.718em) — turns a baseline into pdfkit's line-top y. */
const ASCENDER = 0.718;

/** The baseline the reference prints at, from a row's top and height. */
function centeredBaseline(rowTop: number, rowHeight: number, size: number): number {
  return rowTop + (rowHeight + ASCENDER * size) / 2;
}

function fontFor(bold: boolean, italic: boolean): string {
  if (bold) return "Helvetica-Bold";
  return italic ? "Helvetica-Oblique" : "Helvetica";
}

interface RunOptions {
  x: number;
  width: number;
  baseline: number;
  size: number;
  align: ColumnAlign;
  bold?: boolean;
  italic?: boolean;
  color: string;
}

/** Draw one run with its BASELINE at `baseline`, centred or left in `width`. */
function drawRun(doc: PDFKit.PDFDocument, text: string, o: RunOptions): void {
  if (text === "") return;
  doc.font(fontFor(o.bold === true, o.italic === true)).fontSize(o.size).fillColor(o.color);
  const width = doc.widthOfString(text);
  const x = o.align === "center" ? o.x + (o.width - width) / 2 : o.x;
  doc.text(text, x, o.baseline - ASCENDER * o.size, { lineBreak: false });
}

function rule(doc: PDFKit.PDFDocument, x1: number, y1: number, x2: number, y2: number): void {
  doc.lineWidth(FORM_LINE_WIDTH).strokeColor(FORM_LINE_COLOR).moveTo(x1, y1).lineTo(x2, y2).stroke();
}

/**
 * Draw one printed row: its bottom rule, and — when the row is ruled off
 * vertically — separators at every column boundary INCLUDING the outer edges.
 * The reference's heading bands and its blank spacer row have no verticals, so
 * those are drawn with `verticals: false`.
 */
function drawRow(
  doc: PDFKit.PDFDocument,
  yTop: number,
  height: number,
  widths: readonly number[],
  options: { shade?: string; verticals?: boolean } = {},
): number {
  const left = PDF_LAYOUT.tableLeft;
  const total = widths.reduce((sum, w) => sum + w, 0);
  const yBottom = yTop + height;

  if (options.shade !== undefined) {
    doc.save().rect(left, yTop, total, height).fill(options.shade).restore();
  }
  if (options.verticals !== false) {
    let x = left;
    rule(doc, x, yTop, x, yBottom);
    for (let i = 0; i < widths.length; i++) {
      x += widths[i]!;
      rule(doc, x, yTop, x, yBottom);
    }
  }
  rule(doc, left, yBottom, left + total, yBottom);
  return yBottom;
}

/** §7 — title, centred on the table. */
function drawHeader(doc: PDFKit.PDFDocument, form: PrintedForm): void {
  drawRun(doc, form.title, {
    x: PDF_LAYOUT.tableLeft,
    width: PDF_LAYOUT.tableWidth,
    baseline: PDF_LAYOUT.titleBaseline,
    size: PDF_LAYOUT.titleSize,
    align: "center",
    bold: true,
    color: FORM_TEXT_COLOR,
  });
}

/** §8 — the compact metadata row: DISTRITO · LOKAL · PETSA · WEEK NO. */
function drawMetadata(doc: PDFKit.PDFDocument, form: PrintedForm): number {
  const yTop = PDF_LAYOUT.tableTop;
  const height = form.metaRowHeight;
  rule(
    doc,
    PDF_LAYOUT.tableLeft,
    yTop,
    PDF_LAYOUT.tableLeft + PDF_LAYOUT.tableWidth,
    yTop,
  );
  const yBottom = drawRow(doc, yTop, height, form.meta.map((c) => c.width), { verticals: true });

  let x = PDF_LAYOUT.tableLeft;
  for (const cell of form.meta) {
    drawRun(doc, cell.text, {
      x,
      width: cell.width,
      baseline: centeredBaseline(yTop, height, cell.size),
      size: cell.size,
      align: "center",
      bold: cell.bold,
      color: FORM_TEXT_COLOR,
    });
    x += cell.width;
  }
  return yBottom;
}

/**
 * §11–§14 — one section: its heading band (no verticals), its shaded header row,
 * then its compact body rows.
 */
function drawSection(doc: PDFKit.PDFDocument, yTop: number, section: PrintedSection, cellSize: number): number {
  const widths = section.columns.map((c) => c.width);

  const headingTop = yTop;
  const headingBottom = drawRow(doc, headingTop, PDF_LAYOUT.headingBandHeight, widths, {
    verticals: false,
  });
  drawRun(doc, section.heading, {
    x: PDF_LAYOUT.tableLeft + PDF_LAYOUT.headingInset,
    width: PDF_LAYOUT.tableWidth - PDF_LAYOUT.headingInset,
    baseline: centeredBaseline(headingTop, PDF_LAYOUT.headingBandHeight, PDF_LAYOUT.headingSize),
    size: PDF_LAYOUT.headingSize,
    align: "left",
    bold: true,
    color: FORM_TEXT_COLOR,
  });

  const headerTop = headingBottom;
  const headerHeight = section.headerRowHeight;
  const headerBottom = drawRow(doc, headerTop, headerHeight, widths, {
    shade: FORM_SHADE_COLOR,
    verticals: true,
  });
  let hx = PDF_LAYOUT.tableLeft;
  for (const column of section.columns) {
    drawRun(doc, column.label, {
      x: hx,
      width: column.width,
      baseline: centeredBaseline(headerTop, headerHeight, PDF_LAYOUT.headerSize),
      size: PDF_LAYOUT.headerSize,
      align: "center",
      bold: true,
      color: FORM_HEADER_TEXT,
    });
    hx += column.width;
  }

  let y = headerBottom;
  for (const row of section.rows) {
    const rowTop = y;
    y = drawRow(doc, rowTop, row.height, widths, { verticals: true });
    let x = PDF_LAYOUT.tableLeft;
    for (let i = 0; i < section.columns.length; i++) {
      const column = section.columns[i]!;
      drawRun(doc, row.cells[i] ?? "", {
        x: x + PDF_LAYOUT.cellPadX,
        width: column.width - PDF_LAYOUT.cellPadX,
        baseline: centeredBaseline(rowTop, row.height, cellSize),
        size: cellSize,
        align: column.dataAlign,
        bold: column.dataBold,
        color: FORM_TEXT_COLOR,
      });
      x += column.width;
    }
  }
  return y;
}

/** §24 — the signature/approval band: blank signing space, name, role. */
function drawSignatureSection(doc: PDFKit.PDFDocument, yTop: number, form: PrintedForm): number {
  const cellWidths =
    form.signatories.length >= 2
      ? [
          PDF_LAYOUT.sigSplit - PDF_LAYOUT.tableLeft,
          PDF_LAYOUT.tableLeft + PDF_LAYOUT.tableWidth - PDF_LAYOUT.sigSplit,
        ]
      : [PDF_LAYOUT.tableWidth];

  const spaceTop = yTop;
  const spaceBottom = drawRow(doc, spaceTop, PDF_LAYOUT.sigSpaceHeight, cellWidths, {
    verticals: true,
  });
  const roleBottom = drawRow(doc, spaceBottom, PDF_LAYOUT.sigRoleRowHeight, cellWidths, {
    verticals: true,
  });

  let x = PDF_LAYOUT.tableLeft;
  form.signatories.slice(0, cellWidths.length).forEach((signatory, index) => {
    const width = cellWidths[index]!;
    // the name is printed on the signing space's bottom line
    drawRun(doc, signatory.name, {
      x,
      width,
      baseline: spaceBottom - PDF_LAYOUT.sigNameBottomPad,
      size: PDF_LAYOUT.sigNameSize,
      align: "center",
      bold: true,
      color: FORM_TEXT_COLOR,
    });
    drawRun(doc, signatory.role, {
      x,
      width,
      baseline: centeredBaseline(spaceBottom, PDF_LAYOUT.sigRoleRowHeight, PDF_LAYOUT.sigRoleSize),
      size: PDF_LAYOUT.sigRoleSize,
      align: "center",
      color: FORM_TEXT_COLOR,
    });
    x += width;
  });
  return roleBottom;
}

/** §25 — the revision line, below the table. */
function drawRevisionFooter(doc: PDFKit.PDFDocument, form: PrintedForm): void {
  drawRun(doc, form.footer, {
    x: PDF_LAYOUT.footerLeft,
    width: PDF_LAYOUT.tableWidth,
    baseline: PDF_LAYOUT.footerBaseline,
    size: PDF_LAYOUT.footerSize,
    align: "left",
    italic: true,
    color: FORM_MUTED_TEXT,
  });
}

/** §26 — DRAFT is status chrome, never part of the printed form: a faint
 *  diagonal watermark that leaves the reference layout undistorted. */
function drawWatermark(doc: PDFKit.PDFDocument, watermark: "DRAFT" | null): void {
  if (watermark === null) return;
  doc.save();
  doc.rotate(-28, { origin: [PAGE_WIDTH / 2, PAGE_HEIGHT / 2] });
  doc
    .font("Helvetica-Bold")
    .fontSize(96)
    .fillColor("#000000")
    .fillOpacity(0.06)
    .text(watermark, 0, PAGE_HEIGHT / 2 - 48, { width: PAGE_WIDTH, align: "center", lineBreak: false });
  doc.fillOpacity(1);
  doc.restore();
}

/**
 * §28 — the fixed-layout page: frame-driven draw functions, explicit
 * coordinates, no auto-flow deciding the form.
 */
export function renderWeeklySuguanPdf(vm: WeeklySuguanViewModel): Promise<Buffer> {
  const form = buildPrintedForm(vm);
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margin: 0,
    info: {
      Title: form.title,
      Author: "PNK Suguan",
      Creator: "PNK Suguan weekly Suguan PDF",
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  drawWatermark(doc, form.watermark);
  drawHeader(doc, form);

  let y = drawMetadata(doc, form);
  for (const section of form.sections) {
    y = drawSection(doc, y, section, form.cellSize);
  }
  y = drawRow(doc, y, form.spacerHeight, [PDF_LAYOUT.tableWidth], { verticals: false });
  y = drawSignatureSection(doc, y, form);
  drawRevisionFooter(doc, form);

  doc.end();
  return done;
}

/** Page count without a parser — the form must ALWAYS be exactly one page. */
export function countPdfPages(buffer: Buffer): number {
  const text = buffer.toString("latin1");
  const counts = [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length;
  return counts;
}

// ---------------------------------------------------------------------------
// Appended Patotoo slip pages
//
// One slip per ASSIGNED teacher row — SUGO (section A), RESERBA (section B),
// RESERBA II (section C) — appended AFTER page 1 in the same document. Built
// from the view model and nothing else: no second query, no second source, no
// parallel assignment calculation and no independent dako/teacher lookup, so
// page 1 and the slips cannot disagree. Rendering lives in
// `suguan-slip-pdf.service`; this module owns the projection onto the form
// because it owns BOTH the view model and the presentation helpers the slips
// must reuse (`formatOras`).
// ---------------------------------------------------------------------------

/**
 * §10 — section order A → B → C, each in the view model's own deterministic
 * dako order. Rows with no teacher are skipped: an unassigned dako has no
 * assignment to acknowledge. Nothing is invented for them.
 */
export function buildSuguanSlips(vm: WeeklySuguanViewModel): SuguanSlip[] {
  const sections: readonly { gampaning: string; rows: SuguanFormRow[] }[] = [
    { gampaning: "SUGO", rows: vm.sectionA.rows },
    { gampaning: "RESERBA", rows: vm.sectionB.rows },
    ...(vm.sectionC === null
      ? []
      : [{ gampaning: "RESERBA II", rows: vm.sectionC.rows }]),
  ];

  const slips: SuguanSlip[] = [];
  for (const section of sections) {
    for (const row of section.rows) {
      if (row.pangalan === null) continue;
      slips.push({
        pangalan: row.pangalan,
        dako: row.dakoName, // as stored — never reconstructed or abbreviated
        weekYear: vm.header.weekYear,
        petsa: vm.header.petsa, // the week's Sunday, MM/DD/YYYY
        oras: formatOras(row.oras), // the SAME presentation helper page 1 uses
        gampaning: section.gampaning,
      });
    }
  }
  return slips;
}

/**
 * The document-wide values every slip copy prints: the minister who held the
 * class (the EXISTING `PASTOR` signatory — no new signatory source) and the
 * form's revision line, which is the view model's own footer.
 */
export function suguanSlipContext(vm: WeeklySuguanViewModel): SuguanSlipContext {
  const pastor = vm.signatories.find((s) => s.role === "PASTOR");
  return {
    ministro: pastor?.name ?? vm.signatories[vm.signatories.length - 1]?.name ?? "",
    footer: vm.footer,
  };
}

export interface WeeklySuguanPdfDocument {
  buffer: Buffer;
  /** one entry per appended page, in print order */
  slips: SuguanSlip[];
  /** values that could not be fitted on one line even at the minimum size */
  oversize: string[];
}

/**
 * Page 1 EXACTLY as `renderWeeklySuguanPdf` draws it — the same draw functions
 * in the same order — followed by one Patotoo slip page per assigned teacher
 * row. The orchestration is deliberately repeated rather than extracted so the
 * existing page-1 renderer stays byte-for-byte untouched; a test asserts page
 * 1's content stream is identical between the two renders, so they cannot drift.
 */
export function renderWeeklySuguanPdfWithSlips(
  vm: WeeklySuguanViewModel,
): Promise<WeeklySuguanPdfDocument> {
  const form = buildPrintedForm(vm);
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margin: 0,
    info: {
      Title: form.title,
      Author: "PNK Suguan",
      Creator: "PNK Suguan weekly Suguan PDF",
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  drawWatermark(doc, form.watermark);
  drawHeader(doc, form);

  let y = drawMetadata(doc, form);
  for (const section of form.sections) {
    y = drawSection(doc, y, section, form.cellSize);
  }
  y = drawRow(doc, y, form.spacerHeight, [PDF_LAYOUT.tableWidth], { verticals: false });
  y = drawSignatureSection(doc, y, form);
  drawRevisionFooter(doc, form);

  const slips = buildSuguanSlips(vm);
  const { oversize } = renderSuguanSlipPages(doc, slips, suguanSlipContext(vm));

  doc.end();
  return done.then((buffer) => ({ buffer, slips, oversize }));
}

/**
 * Assemble + render for one ISO week (READ-ONLY): page 1, then one Patotoo slip
 * page per assigned teacher row. Mutates nothing — the slips are a pure read of
 * the same schedule page 1 prints.
 */
export async function generateWeeklySuguanPdf(weekId: string): Promise<{
  buffer: Buffer;
  vm: WeeklySuguanViewModel;
  slips: SuguanSlip[];
  oversize: string[];
}> {
  const vm = await buildWeeklySuguanViewModel(weekId);
  const { buffer, slips, oversize } = await renderWeeklySuguanPdfWithSlips(vm);
  if (oversize.length > 0) {
    // Never silent: a value that cannot be fitted on one line is reported for
    // an operator to see, rather than truncated or wrapped into the cell.
    console.warn(`[weekly-suguan-pdf] ${oversize.length} slip value(s) did not fit: ${oversize.join(" | ")}`);
  }
  return { buffer, vm, slips, oversize };
}

void and;
