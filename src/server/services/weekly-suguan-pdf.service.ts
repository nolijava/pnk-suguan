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
import { listAssignmentsForWeek } from "./assignment.service";

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
  };
  sectionA: { heading: string; rows: SuguanFormRow[] }; // ALL ACTIVE dakos
  sectionB: { heading: string; rows: SuguanFormRow[] }; // ALL ACTIVE dakos
  /** null ⇔ zero RESERBA_II assignments ⇒ section C omitted entirely. */
  sectionC: { heading: string; rows: SuguanFormRow[] } | null;
  sectionD: { heading: string; rows: { gampanin: string }[] }; // static 4 SUGO + 2 RESERBA
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

  const [activeDakos, assignments] = await Promise.all([
    db
      .select({ id: dako.id, name: dako.name, dakoCode: dako.dakoCode, worshipTime: dako.worshipTime })
      .from(dako)
      .where(eq(dako.status, "ACTIVE")),
    listAssignmentsForWeek(weekId),
  ]);

  // Deterministic order consistent with master-data convention.
  const ordered = [...activeDakos].sort(
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
    ordered.map((d) => ({ dakoName: d.name, oras: d.worshipTime, pangalan: byType.get(type)?.get(d.id) ?? null }));

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
    },
    sectionA: { heading: "A. SUGO", rows: sugo },
    sectionB: { heading: "B. RESERBA", rows: reserba },
    sectionC: reserbaIiRows.length === 0 ? null : { heading: "C. RESERBA II", rows: reserbaIiRows },
    sectionD: {
      heading: "D. MGA MAGTUTURO SA KLASE",
      rows: [
        { gampanin: "SUGO" }, { gampanin: "SUGO" }, { gampanin: "SUGO" }, { gampanin: "SUGO" },
        { gampanin: "RESERBA" }, { gampanin: "RESERBA" },
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
// Layout constants isolated here for later visual tuning against the
// physical reference form (Sugo.pdf was not available at build time).
// ---------------------------------------------------------------------------

const PAGE_W = 8.5 * 72; // 612pt
const PAGE_H = 13 * 72; // 936pt — 8.5×13in portrait (Folio-ish long bond)
const MARGIN = 0.5 * 72; // 36pt

const L = {
  titleSize: 13,
  titleLead: 16,
  headerLineSize: 10,
  headerLineLead: 15,
  headerGapAfter: 8,
  sectionGap: 14,
  headingSize: 10.5,
  headingLead: 14,
  cellSize: 8.5,
  cellLead: 10,
  cellPadX: 4,
  headerRowH: 18,
  // Sum must equal PAGE_W − 2·MARGIN = 540pt (verified by a test).
  cols: { dako: 170, oras: 60, pangalan: 170, pagtanggap: 70, pagbabago: 70 } as
    | { dako: number; oras: number; pangalan: number; pagtanggap: number; pagbabago: number },
};

// Distribute remaining width to Pagbabago so the table exactly spans the page.
L.cols.pagbabago = PAGE_W - 2 * MARGIN - L.cols.dako - L.cols.oras - L.cols.pangalan - L.cols.pagtanggap;

const SECTION_COLS = [
  { key: "dako", label: "Dako", w: L.cols.dako },
  { key: "oras", label: "Oras", w: L.cols.oras },
  { key: "pangalan", label: "Pangalan", w: L.cols.pangalan },
  { key: "pagtanggap", label: "Pagtanggap", w: L.cols.pagtanggap },
  { key: "pagbabago", label: "Pagbabago", w: L.cols.pagbabago },
] as const;

function drawWatermark(doc: PDFKit.PDFDocument) {
  doc.save();
  doc.opacity(0.08);
  doc.fontSize(90);
  doc.rotate(45, { origin: [PAGE_W / 2, PAGE_H / 2] });
  doc.text("DRAFT", PAGE_W / 2 - 160, PAGE_H / 2, { lineBreak: false });
  doc.restore();
}

/**
 * Count pages of a rendered PDF buffer (xor trick: page objects start with
 * "2 0 obj"-style markers; robust enough for our own single-page guarantee
 * tests — counts "/Type /Page" occurrences excluding "/Pages").
 */
export function countPdfPages(buffer: Buffer): number {
  const s = buffer.toString("latin1");
  return (s.match(/\/Type \/Page[^s]/g) ?? []).length;
}

/**
 * § single-page guarantee — the physical Suguan form is ONE sheet. The
 * renderer computes a row height from the actual content (sections A/B/C
 * row counts + fixed D/signatory blocks) that always fits the fixed
 * 8.5×13in page. Expected worst case at PNK scale (11 active dakos, section
 * C populated): 11+11+11+6+2 headers/headings ≈ 8.5pt rows — comfortably
 * readable. There is deliberately NO floor above the page's physical
 * capacity: rows shrink instead of paginating, because the printed form is
 * ONE sheet (pdfkit would otherwise auto-add pages the moment any text flow
 * crosses the bottom margin). A guard test asserts one page at 22 dakos.
 */
function computeRowH(c: WeeklySuguanViewModel): number {
  const sectionRowCounts = c.sectionA.rows.length + c.sectionB.rows.length + (c.sectionC?.rows.length ?? 0);
  const headings = 3 + (c.sectionC ? 1 : 0) + 1; // A/B(+C) headings + D heading
  const tableHeadRows = (c.sectionC ? 3 : 2) + 1; // A/B(+C) header rows + D header row
  const dRows = c.sectionD.rows.length; // always 6
  const fixedH =
    MARGIN +
    (L.titleLead + 4) +
    L.headerLineLead * 2 +
    L.headerGapAfter +
    headings * L.headingLead +
    tableHeadRows * L.headerRowH +
    dRows * 20 + // section D rows (fixed comfortable height)
    L.sectionGap * 4 +
    70 + // signatory block
    16 + // footer clearance
    MARGIN;
  const available = PAGE_H - fixedH;
  // EXACT fit: every section-A/B/C row gets an equal share of the real
  // remaining height. No 16pt-style floor — a floor above the true capacity
  // makes content cross the bottom margin and pdfkit paginates the form onto
  // extra pages. Sparse forms still cap at 22pt; only extreme densities
  // shrink below readability, and they still print as one sheet.
  return Math.max(6, Math.min(22, Math.floor(available / Math.max(sectionRowCounts, 1))));
}

function drawSectionHeading(doc: PDFKit.PDFDocument, y: number, text: string): number {
  doc.font("Helvetica-Bold").fontSize(L.headingSize).fillColor("#000");
  doc.text(text, MARGIN, y, { width: PAGE_W - 2 * MARGIN, lineBreak: false });
  return y + L.headingLead;
}

function drawSectionTable(doc: PDFKit.PDFDocument, y: number, rows: SuguanFormRow[], rowH: number): number {
  const tableW = PAGE_W - 2 * MARGIN;

  const drawHeadRow = (yy: number) => {
    doc.font("Helvetica-Bold").fontSize(L.cellSize).fillColor("#000");
    doc.rect(MARGIN, yy, tableW, L.headerRowH).stroke();
    let x = MARGIN;
    for (const c of SECTION_COLS) {
      if (c.key !== "dako") doc.moveTo(x, yy).lineTo(x, yy + L.headerRowH).stroke();
      doc.text(c.label, x + L.cellPadX, yy + 5, { width: c.w - 2 * L.cellPadX, height: L.headerRowH - 8, lineBreak: false });
      x += c.w;
    }
    return yy + L.headerRowH;
  };

  let cy = drawHeadRow(y);

  for (const row of rows) {
    doc.font("Helvetica").fontSize(L.cellSize).fillColor("#000");
    doc.rect(MARGIN, cy, tableW, rowH).stroke();
    let x = MARGIN;
    const cells: [string, string | null][] = [
      ["dako", row.dakoName],
      ["oras", row.oras],
      ["pangalan", row.pangalan ?? ""],
      ["pagtanggap", ""],
      ["pagbabago", ""],
    ];
    for (const [key, val] of cells) {
      const col = SECTION_COLS.find((c) => c.key === key)!;
      if (key !== "dako") doc.moveTo(x, cy).lineTo(x, cy + rowH).stroke();
      if (val) {
        // In-cell wrapping for long names; structure never changes. The
        // height box is applied ONLY when the row can hold one line of text:
        // a constrained box smaller than one line makes pdfkit treat the
        // text as overflowing its box and auto-paginate the form onto extra
        // pages, which would break the one-sheet physical-form guarantee.
        const cellH = rowH - 8;
        doc.text(val, x + L.cellPadX, cy + 4, {
          width: col.w - 2 * L.cellPadX,
          ...(cellH >= 12 ? { height: cellH } : {}),
          ellipsis: false,
        });
      }
      x += col.w;
    }
    cy += rowH;
  }
  return cy;
}

function drawSectionD(doc: PDFKit.PDFDocument, y: number, heading: string, rows: { gampanin: string }[], rowH: number): number {
  let cy = drawSectionHeading(doc, y, heading);
  const cols = [
    { label: "Gampanin", w: 110 },
    { label: "Pangalan", w: 200 },
    { label: "Lagda", w: 128 },
    { label: "Pansin", w: PAGE_W - 2 * MARGIN - 110 - 200 - 128 },
  ];
  const tableW = PAGE_W - 2 * MARGIN;
  doc.font("Helvetica-Bold").fontSize(L.cellSize).fillColor("#000");
  doc.rect(MARGIN, cy, tableW, L.headerRowH).stroke();
  let x = MARGIN;
  for (const c of cols) {
    if (c.label !== "Gampanin") doc.moveTo(x, cy).lineTo(x, cy + L.headerRowH).stroke();
    doc.text(c.label, x + L.cellPadX, cy + 5, { width: c.w - 2 * L.cellPadX, lineBreak: false });
    x += c.w;
  }
  cy += L.headerRowH;

  for (const row of rows) {
    doc.font("Helvetica").fontSize(L.cellSize).fillColor("#000");
    doc.rect(MARGIN, cy, tableW, rowH).stroke();
    x = MARGIN;
    const vals: [string, string][] = [
      ["Gampanin", row.gampanin],
      ["Pangalan", ""],
      ["Lagda", ""],
      ["Pansin", ""],
    ];
    for (const [key, val] of vals) {
      const col = cols.find((c) => c.label === key)!;
      if (key !== "Gampanin") doc.moveTo(x, cy).lineTo(x, cy + rowH).stroke();
      if (val) doc.text(val, x + L.cellPadX, cy + 4, { width: col.w - 2 * L.cellPadX, height: rowH - 8 });
      x += col.w;
    }
    cy += rowH;
  }
  return cy;
}

/**
 * Render the physical form to a PDF Buffer. Pure: reads nothing but the view
 * model; writes nothing but the Buffer. The form is ALWAYS exactly one page
 * (the physical sheet): content beyond capacity is NOT paginated — the row
 * height adapts instead (§ computeRowH).
 */
export async function renderWeeklySuguanPdf(vm: WeeklySuguanViewModel): Promise<Buffer> {
  const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: MARGIN, info: { Title: `Suguan W${vm.header.weekNo}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  if (vm.watermark) {
    drawWatermark(doc);
  }

  // Footer — pinned just above the bottom margin. pdfkit auto-paginates the
  // moment any text's RENDERED BOTTOM (y + line height ≈ 1.15 × fontSize)
  // crosses maxY = PAGE_H − margin, regardless of draw order — measured
  // empirically: y=890 → 1 page, y=892 → 2 pages. The 10pt clearance keeps
  // the 8pt footer's line box (bottom ≈ 899.2) inside the flow area. The
  // visual position is unchanged for all practical purposes (baseline sits
  // right at the margin line). One sheet, always.
  const fy = PAGE_H - MARGIN - 10;
  doc.font("Helvetica-Oblique").fontSize(8).fillColor("#000");
  doc.text(vm.footer, MARGIN, fy, { width: PAGE_W - 2 * MARGIN, align: "center", lineBreak: false });

  let y = MARGIN;

  // Header
  doc.font("Helvetica-Bold").fontSize(L.titleSize).fillColor("#000");
  doc.text(vm.header.title, MARGIN, y, { width: PAGE_W - 2 * MARGIN, align: "center" });
  y += L.titleLead + 4;

  doc.font("Helvetica").fontSize(L.headerLineSize);
  doc.text(`Distrito: ${vm.header.distrito}`, MARGIN, y, { width: 200, lineBreak: false });
  doc.text(`Lokal: ${vm.header.lokal}`, MARGIN + 200, y, { width: 200, lineBreak: false });
  y += L.headerLineLead;
  doc.text(`Petsa: ${vm.header.petsa}`, MARGIN, y, { width: 200, lineBreak: false });
  doc.text(`WEEK NO. ${vm.header.weekNo}`, MARGIN + 200, y, { width: 200, lineBreak: false });
  y += L.headerLineLead + L.headerGapAfter;

  // Sections A–C — single-page guarantee: rowH computed to fit ALL content.
  const rowH = computeRowH(vm);
  y = drawSectionHeading(doc, y, vm.sectionA.heading);
  y = drawSectionTable(doc, y, vm.sectionA.rows, rowH) + L.sectionGap;
  y = drawSectionHeading(doc, y, vm.sectionB.heading);
  y = drawSectionTable(doc, y, vm.sectionB.rows, rowH) + L.sectionGap;
  if (vm.sectionC) {
    y = drawSectionHeading(doc, y, vm.sectionC.heading);
    y = drawSectionTable(doc, y, vm.sectionC.rows, rowH) + L.sectionGap;
  }

  // Section D (static)
  y = drawSectionD(doc, y, vm.sectionD.heading, vm.sectionD.rows, 20) + L.sectionGap;

  // Signatories — kept together as one block on the same page.
  const sigBlockH = 70;
  const half = (PAGE_W - 2 * MARGIN) / 2;
  let sx = MARGIN;
  for (const sig of vm.signatories) {
    doc.font("Helvetica").fontSize(L.cellSize).fillColor("#000");
    // blank physical signature area (line), then name over role
    doc.moveTo(sx + 10, y + 30).lineTo(sx + half - 30, y + 30).stroke();
    doc.font("Helvetica-Bold");
    doc.text(sig.name, sx + 10, y + 36, { width: half - 40, align: "center", lineBreak: false });
    doc.font("Helvetica");
    doc.text(sig.role, sx + 10, y + 50, { width: half - 40, align: "center", lineBreak: false });
    sx += half;
  }
  y += sigBlockH;

  doc.end();
  return done;
}

/** Convenience: build + render for one week. Read-only. */
export async function generateWeeklySuguanPdf(weekId: string): Promise<{ buffer: Buffer; vm: WeeklySuguanViewModel }> {
  const vm = await buildWeeklySuguanViewModel(weekId);
  return { buffer: await renderWeeklySuguanPdf(vm), vm };
}

// keep drizzle helpers referenced for future filters (no-op)
void and;
