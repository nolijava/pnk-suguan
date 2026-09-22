/**
 * Patotoo slip pages — the per-teacher forms APPENDED after page 1 of the
 * Weekly Suguan PDF.
 *
 * SCOPE. This module renders the added pages only. Page 1 is drawn by
 * `weekly-suguan-pdf.service` exactly as before, by exactly the same draw
 * functions in the same order; nothing here touches it. The two copies that
 * make up a slip page carry the SAME data, the SAME geometry and the SAME
 * fitted font sizes — the watermark (`ORIGINAL` / `DUPLICATE`, rotated exactly
 * 45°) is the only intended difference.
 *
 * CALIBRATED AGAINST THE PHYSICAL REFERENCE FORM (`Suguan Slip.pdf`) by
 * measuring the reference itself — page box, every rule, the embedded seal,
 * per-run fonts/sizes, the kerning-adjusted start x of every text run — rather
 * than approximating it:
 *   • the reference is A4 (595.2 × 841.8pt) with TWO identical copies stacked,
 *     copy 2 exactly 384.10pt below copy 1. THIS layer re-lays that copy out on
 *     the app's mandatory 8.5 × 13in portrait sheet (612 × 936pt), scaled by
 *     `SLIP_SCALE` — the reference's own margin is preserved, so the form is as
 *     wide as the sheet allows, and the sheet is split into two EQUAL 468pt
 *     halves with one copy centred in each.
 *   • the reference's rules are ~1pt black (a 0.2pt stroked path plus a 1pt
 *     filled bar — the visible result), with no shading, no fills and no page
 *     frame; the single bordered table IS the form's boundary.
 *   • the reference prints in Arial / Arial-Bold / Calibri / Calibri-Bold.
 *     Arial and Helvetica are metric-compatible, so the Arial-set runs (field
 *     labels, data row, declaration, footer) keep their measured sizes exactly;
 *     the Calibri-set runs use Helvetica as a stand-in, sized to reproduce the
 *     reference's PRINTED width (see `calibri()`), the same convention
 *     `PDF_LAYOUT.titleSize` documents.
 *   • the reference contains NO watermark of any kind. `ORIGINAL` / `DUPLICATE`
 *     are new system-generated elements; `DRAFT` never appears on a slip page.
 *
 * Every text value drawn here is data. The only literals are the reference
 * form's own static labels, the declaration paragraph and the seal.
 */
import { pnkSealJpeg } from "./assets/pnk-seal";

// ---------------------------------------------------------------------------
// Sheet and scale
//
// The sheet is the SAME 8.5 × 13in portrait page the weekly form uses (612 ×
// 936pt). Those two numbers are declared locally rather than imported from
// `weekly-suguan-pdf.service` because that module imports THIS one: reading its
// constants here would create an evaluation-order cycle. A test asserts the slip
// pages' MediaBox equals the weekly form's, so the two cannot silently diverge.
// ---------------------------------------------------------------------------

export const SLIP_PAGE_WIDTH = 612; // 8.5in × 72
export const SLIP_PAGE_HEIGHT = 936; // 13in × 72
/** the page is cut horizontally through the middle into two equal halves */
export const SLIP_HALF_HEIGHT = SLIP_PAGE_HEIGHT / 2; // 468

/**
 * The reference's own page margin (measured: 31.30pt left, 32.50pt right of its
 * A4 sheet — averaged) and the width of one copy's content as measured on the
 * reference (its table's left border at 31.30 through its signature rule's right
 * end at 562.70). Scaling the copy to `SLIP_PAGE_WIDTH − 2 × this margin` keeps
 * the reference's margin and fills the 8.5in width without distorting anything.
 */
export const SLIP_PAGE_MARGIN = 31.90;
export const SLIP_REFERENCE_CONTENT_WIDTH = 531.4;
export const SLIP_SCALE = (SLIP_PAGE_WIDTH - 2 * SLIP_PAGE_MARGIN) / SLIP_REFERENCE_CONTENT_WIDTH;

/** one copy's printed height, and the slack a half leaves around it */
export const SLIP_REFERENCE_CONTENT_TOP = 24.21;
export const SLIP_REFERENCE_CONTENT_HEIGHT = 340.89; // 24.21 → 365.10 (footer baseline + descent)
export const SLIP_COPY_HEIGHT = SLIP_REFERENCE_CONTENT_HEIGHT * SLIP_SCALE;
export const SLIP_COPY_SLACK = (SLIP_HALF_HEIGHT - SLIP_COPY_HEIGHT) / 2;
/** where each copy's content starts, on the sheet */
export const SLIP_COPY_TOPS = [
  SLIP_COPY_SLACK,
  SLIP_HALF_HEIGHT + SLIP_COPY_SLACK,
] as const;

/** the form's left edge on the sheet — the reference's margin, scaled to the page */
export const SLIP_LEFT = SLIP_PAGE_MARGIN;

// ---------------------------------------------------------------------------
// Reference geometry (`fromTop` points on the reference's own A4 page)
// ---------------------------------------------------------------------------

export const SLIP_RULE_WIDTH = 1;
export const SLIP_RULE_COLOR = "#000000"; // the reference's rules are black
export const SLIP_TEXT_COLOR = "#000000";

/**
 * Every coordinate and size measured from `Suguan Slip.pdf`, copy 1. Rendered
 * coordinates are `slipX()` / `slipY()` of these values, so the generated sheet
 * can be measured and divided by `SLIP_SCALE` and diffed against the reference
 * directly.
 */
export const SLIP_DESIGN = {
  // the embedded seal, top-left of each copy
  sealLeft: 33.81,
  sealRight: 94.06,
  sealTop: 24.21,
  sealBottom: 83.16,

  // title / subtitle — centred in the cell to the RIGHT of the seal
  titleCellLeft: 96.63,
  titleCellRight: 562.61,
  titleBaseline: 41.8,
  subtitleBaseline: 72.4,

  // the one bordered table: the form's boundary
  boxLeft: 31.3,
  boxRight: 562.3,
  boxTop: 89.13,
  fieldRowBottom: 135.53,
  headerRowBottom: 180.95,
  dataRowBottom: 247.55,
  boxBottom: 310.58,

  // column boundaries
  tableSplit1: 152.15, // DAKO | PETSA (field/header/data rows only)
  tableSplit2: 262.38, // PETSA | ORAS — also the Pangalan | Tungkulin field edge
  tableSplit3: 354.43, // ORAS | RESIBO (field/header/data rows only)
  tableSplit4: 444.65, // RESIBO | GAMPANING — also the declaration | Lagda edge

  // baselines
  fieldLabelBaseline: 103.63,
  fieldValueBaseline: 129.42,
  headerBaseline: 163.63, // single-line header labels
  receiptBaseline1: 153.42, // "RESIBO" / "BILANG" — the reference's own two lines
  receiptBaseline2: 173.83,
  gampaningBaseline1: 154.42, // "GAMPANING" / "TUTUPARIN" — shrunk in the source
  gampaningBaseline2: 170.02,
  dataBaseline: 219.25,
  lagdaBaseline: 259.05,
  declarationBaseline1: 267.85,
  declarationBaseline2: 283.08,
  declarationBaseline3: 298.47,
  signatoryNameBaseline: 346.67,
  ministroBaseline: 348.67,
  signatureRuleY: 354.78,
  signatureRuleLeft: 354.83,
  signatureRuleRight: 562.7,
  /** the minister's name sits on the signing line, at this measured x */
  signatoryNameLeft: 415.55,
  ministroLabelLeft: 155.65,
  footerBaseline: 363.08,
  footerLeft: 33.4,

  // insets measured inside the field cells
  fieldLabelInset: 2.5, // baseline labels sit this far right of their cell's rule
  fieldValueInset: 3.3, // the teacher name

  // the reference's declaration: 3 lines, the 2nd and 3rd starting a second run
  // at these measured x positions (the source's own spacing, reproduced as-is)
  declarationLeft: 34.0,
  declarationLine2BoldX: 331.5,
  declarationLine3BoldPostX: 196.08,

  // reference point sizes, per run (Arial-based runs are used verbatim)
  titleSize: 12, // Calibri-Bold
  fieldLabelSize: 11, // Arial-Bold
  fieldValueNameSize: 18, // Calibri
  fieldValueBigSize: 20, // Calibri
  headerSize: 16, // Calibri
  headerLongSize: 12, // Calibri, shrink-to-fit in the source
  dataSize: 14, // Arial
  declarationSize: 12, // Arial / Arial-Bold
  signatoryNameSize: 11, // Calibri
  ministroSize: 20, // Calibri
  footerSize: 8, // Arial
} as const;

/**
 * Calibri → Helvetica stand-in factor.
 *
 * The reference sets its title, field values, table headers, ministro label and
 * signatory name in Calibri, which PDFKit's core fonts cannot supply. Measured
 * on the reference's own strings, Calibri's advances are ≈0.865× Helvetica's, so
 * those runs are drawn at this fraction of their nominal size to reproduce the
 * reference's PRINTED width instead of its nominal point size — exactly the
 * convention `PDF_LAYOUT.titleSize` (15pt for a 14pt VDarna run) documents.
 */
export const CALIBRI_STAND_IN = 0.865;

/** A Calibri-set run's size, as drawn with the Helvetica stand-in. */
export function calibri(size: number): number {
  return size * CALIBRI_STAND_IN;
}

// ---------------------------------------------------------------------------
// The reference's own static text
// ---------------------------------------------------------------------------

export const SLIP_TITLE = "SUGUAN SA PAGSAMBA NG KABATAAN";
export const SLIP_SUBTITLE = "PATOTOO UKOL SA PAGTATANGGAP NG SUGUAN NG MGA GURO SA P.N.K";
/** the reference prints the role of every teacher on this form as GURO */
export const SLIP_TUNGKULIN = "GURO";
export const SLIP_FIELD_LABELS = {
  pangalan: "Pangalan:",
  tungkulin: "Tungkulin:",
  weekYear: "Week - Year:",
} as const;
/** one line per row; the receipt and gampaning labels print on two lines */
export const SLIP_TABLE_HEADERS = [
  ["DAKO"],
  ["PETSA"],
  ["ORAS"],
  ["RESIBO", "BILANG"],
  ["GAMPANING", "TUTUPARIN"],
] as const;
export const SLIP_LAGDA_LABEL = "Lagda:";
export const SLIP_SIGNATORY_LABEL = "Ministrong Nagklase:";

/**
 * The declaration, split exactly as the reference prints it — the first run of
 * lines 2 and 3, then the bold run. `bold` runs use Arial-Bold in the reference.
 */
export const SLIP_DECLARATION = [
  { bold: false, baseline: SLIP_DESIGN.declarationBaseline1, x: SLIP_DESIGN.declarationLeft, text: "Pinatutunayan ko po na aking natanggap ang aking suguan. Ito po ay aking" },
  { bold: false, baseline: SLIP_DESIGN.declarationBaseline2, x: SLIP_DESIGN.declarationLeft, text: "nasisayasat at ganap ko pong nauunawaan ang" },
  { bold: true, baseline: SLIP_DESIGN.declarationBaseline2, x: SLIP_DESIGN.declarationLine2BoldX, text: "Dako, Petsa, Oras" },
  { bold: true, baseline: SLIP_DESIGN.declarationBaseline3, x: SLIP_DESIGN.declarationLeft, text: "at Tungkuling Gagampanan" },
  { bold: false, baseline: SLIP_DESIGN.declarationBaseline3, x: SLIP_DESIGN.declarationLine3BoldPostX, text: "sa mga pagsamba sa Linggong ito." },
] as const;

/** The two watermarks. `ORIGINAL` tops the page, `DUPLICATE` closes it. */
export const SLIP_WATERMARKS = ["ORIGINAL", "DUPLICATE"] as const;
export type SlipWatermark = (typeof SLIP_WATERMARKS)[number];
/** exactly 45°, per the form's specification */
export const SLIP_WATERMARK_ANGLE = 45;
export const SLIP_WATERMARK_SIZE = 64;
export const SLIP_WATERMARK_OPACITY = 0.07;

// ---------------------------------------------------------------------------
// Geometry helpers — reference coordinates → sheet coordinates
// ---------------------------------------------------------------------------

/** A reference x on the sheet (scaled, with the reference's own margin kept). */
export function slipX(referenceX: number): number {
  return SLIP_LEFT + (referenceX - SLIP_DESIGN.boxLeft) * SLIP_SCALE;
}

/** A reference `fromTop` y on the sheet, for copy 0 (ORIGINAL) or 1 (DUPLICATE). */
export function slipY(referenceY: number, copy: 0 | 1): number {
  return (
    SLIP_COPY_TOPS[copy] +
    (referenceY - SLIP_REFERENCE_CONTENT_TOP) * SLIP_SCALE
  );
}

export interface SlipCell {
  readonly left: number;
  readonly right: number;
  readonly width: number;
}

function cell(referenceLeft: number, referenceRight: number): SlipCell {
  const left = slipX(referenceLeft);
  const right = slipX(referenceRight);
  return { left, right, width: right - left };
}

/** The three field cells of the top band: Pangalan · Tungkulin · Week - Year. */
export function slipFieldCells(): SlipCell[] {
  const { boxLeft, tableSplit2, tableSplit4, boxRight } = SLIP_DESIGN;
  return [cell(boxLeft, tableSplit2), cell(tableSplit2, tableSplit4), cell(tableSplit4, boxRight)];
}

/** The five columns the header and data bands share. */
export function slipTableColumns(): SlipCell[] {
  const { boxLeft, tableSplit1, tableSplit2, tableSplit3, tableSplit4, boxRight } = SLIP_DESIGN;
  return [
    cell(boxLeft, tableSplit1),
    cell(tableSplit1, tableSplit2),
    cell(tableSplit2, tableSplit3),
    cell(tableSplit3, tableSplit4),
    cell(tableSplit4, boxRight),
  ];
}

/**
 * Slack left inside a cell for its text: the reference's own insets, scaled.
 * Used as the fitter's width budget so a fitted value can never touch a rule.
 */
const CELL_PAD = 2.5;

function fitWidth(width: number, leftInset = 0): number {
  return width - (leftInset + CELL_PAD) * SLIP_SCALE;
}

// ---------------------------------------------------------------------------
// Text fitting — ONE line per cell, never wrapped, never ellipsized
// ---------------------------------------------------------------------------

/** Below this the printed value would stop being legible; report, don't shrink. */
export const SLIP_MIN_TEXT_SIZE = 6;

const FIT_STEP = 0.25;

/**
 * The largest size at or below `size` at which `text` fits `width` on ONE line.
 *
 * Deliberately a pure measurement loop over `widthOfString` — the cell, row,
 * column and page geometry are fixed by `SLIP_DESIGN` and are never adjusted to
 * accommodate a long value, and nothing is ever truncated or wrapped: the FONT
 * gives way instead. The caller renders with `lineBreak: false`.
 */
export function fitSingleLine(
  doc: PDFKit.PDFDocument,
  text: string,
  options: { font: string; size: number; width: number; minSize?: number },
): number {
  const minSize = options.minSize ?? SLIP_MIN_TEXT_SIZE;
  if (text === "") return options.size;
  doc.font(options.font);
  let size = options.size;
  while (size > minSize && doc.fontSize(size).widthOfString(text) > options.width) {
    size = Math.max(minSize, Number((size - FIT_STEP).toFixed(2)));
  }
  return size;
}

// ---------------------------------------------------------------------------
// Drawing primitives (mirroring the weekly layer's conventions)
// ---------------------------------------------------------------------------

/**
 * Helvetica's cap height as a fraction of its size — the baseline conversion
 * the weekly form also uses, so a baseline means the same thing in both layers.
 */
const ASCENDER = 0.718;

function fontFor(bold: boolean): string {
  return bold ? "Helvetica-Bold" : "Helvetica";
}

interface SingleLineOptions {
  x: number;
  baseline: number;
  size: number;
  bold?: boolean;
  /** when set, the run is centred in `[x, x + width]` */
  width?: number;
  color?: string;
}

/** Draw one run on ONE line (`lineBreak: false`) with its BASELINE at `baseline`. */
function drawSingleLine(
  doc: PDFKit.PDFDocument,
  text: string,
  o: SingleLineOptions,
): void {
  if (text === "") return;
  const bold = o.bold === true;
  doc.font(fontFor(bold)).fontSize(o.size).fillColor(o.color ?? SLIP_TEXT_COLOR);
  const x = o.width === undefined ? o.x : o.x + (o.width - doc.widthOfString(text)) / 2;
  doc.text(text, x, o.baseline - ASCENDER * o.size, { lineBreak: false });
}

function slipRule(
  doc: PDFKit.PDFDocument,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  doc
    .lineWidth(SLIP_RULE_WIDTH)
    .strokeColor(SLIP_RULE_COLOR)
    .moveTo(x1, y1)
    .lineTo(x2, y2)
    .stroke();
}

/**
 * The watermark for one copy. NEW SYSTEM ELEMENT — the reference carries no
 * watermark at all. Rotated exactly 45°, faint, drawn BEFORE the form so it can
 * never obscure a rule or a value.
 */
function drawSlipWatermark(
  doc: PDFKit.PDFDocument,
  label: SlipWatermark,
  copy: 0 | 1,
): void {
  const centreX = SLIP_PAGE_WIDTH / 2;
  const centreY = SLIP_COPY_TOPS[copy] + SLIP_COPY_HEIGHT / 2;
  doc.save();
  doc.rotate(SLIP_WATERMARK_ANGLE, { origin: [centreX, centreY] });
  doc
    .font("Helvetica-Bold")
    .fontSize(SLIP_WATERMARK_SIZE)
    .fillColor(SLIP_TEXT_COLOR)
    .fillOpacity(SLIP_WATERMARK_OPACITY)
    .text(label, 0, centreY - SLIP_WATERMARK_SIZE / 2, {
      width: SLIP_PAGE_WIDTH,
      align: "center",
      lineBreak: false,
    });
  doc.fillOpacity(1);
  doc.restore();
}

// ---------------------------------------------------------------------------
// The slip
// ---------------------------------------------------------------------------

/**
 * One teacher assignment, ready to print. Every field is data from the week's
 * own view model (see `buildSuguanSlips` in `weekly-suguan-pdf.service`) — there
 * are no example values anywhere in this layer.
 */
export interface SuguanSlip {
  /** the assigned teacher */
  pangalan: string;
  /** the dako name exactly as stored */
  dako: string;
  /** `<iso week number>-<stored year>` — the week's own row, never a literal */
  weekYear: string;
  /** the week's Sunday, MM/DD/YYYY */
  petsa: string;
  /** the dako's worship time, printed compact (9AM) */
  oras: string;
  /** SUGO / RESERBA / RESERBA II */
  gampaning: string;
}

/** Document-wide values every copy prints identically. */
export interface SuguanSlipContext {
  /** the minister's name — the existing signatory, never a new source */
  ministro: string;
  /** the form's revision line, from the view model */
  footer: string;
}

export interface SuguanSlipRenderResult {
  /** values that could not be fitted on one line even at the minimum size */
  oversize: string[];
}

/**
 * Fitted sizes, computed ONCE per slip and reused verbatim by both copies, so
 * the ORIGINAL and the DUPLICATE are geometrically identical even for a long
 * name.
 */
interface SlipFits {
  pangalan: number;
  dako: number;
  weekYear: number;
  petsa: number;
  oras: number;
  gampaning: number;
  ministro: number;
}

function fitSlip(
  doc: PDFKit.PDFDocument,
  slip: SuguanSlip,
  ctx: SuguanSlipContext,
  oversize: string[],
): SlipFits {
  const fields = slipFieldCells();
  const columns = slipTableColumns();
  const fits: Record<keyof SlipFits, number> = {
    pangalan: 0,
    dako: 0,
    weekYear: 0,
    petsa: 0,
    oras: 0,
    gampaning: 0,
    ministro: 0,
  };

  const fit = (
    key: keyof SlipFits,
    text: string,
    size: number,
    width: number,
    what: string,
  ): void => {
    fits[key] = fitSingleLine(doc, text, { font: fontFor(false), size, width });
    if (fits[key] <= SLIP_MIN_TEXT_SIZE && doc.fontSize(SLIP_MIN_TEXT_SIZE).widthOfString(text) > width) {
      oversize.push(
        `${slip.gampaning} · ${slip.dako} · ${what} "${text}" needs more than ${width.toFixed(1)}pt of room at ${SLIP_MIN_TEXT_SIZE}pt`,
      );
    }
  };

  fit("pangalan", slip.pangalan, calibri(SLIP_DESIGN.fieldValueNameSize), fitWidth(fields[0]!.width, SLIP_DESIGN.fieldValueInset), "Pangalan");
  fit("dako", slip.dako, SLIP_DESIGN.dataSize, fitWidth(columns[0]!.width), "DAKO");
  fit("weekYear", slip.weekYear, calibri(SLIP_DESIGN.fieldValueBigSize), fitWidth(fields[2]!.width), "Week - Year");
  fit("petsa", slip.petsa, SLIP_DESIGN.dataSize, fitWidth(columns[1]!.width), "PETSA");
  fit("oras", slip.oras, SLIP_DESIGN.dataSize, fitWidth(columns[2]!.width), "ORAS");
  fit("gampaning", slip.gampaning, SLIP_DESIGN.dataSize, fitWidth(columns[4]!.width), "GAMPANING TUTUPARIN");
  fit(
    "ministro",
    ctx.ministro,
    calibri(SLIP_DESIGN.signatoryNameSize),
    fitWidth(SLIP_DESIGN.signatureRuleRight - SLIP_DESIGN.signatoryNameLeft),
    "Ministrong Nagklase",
  );

  return fits;
}

/** Draw ONE copy of the slip: `copy` 0 = ORIGINAL (top half), 1 = DUPLICATE. */
function drawSlipCopy(
  doc: PDFKit.PDFDocument,
  copy: 0 | 1,
  slip: SuguanSlip,
  ctx: SuguanSlipContext,
  fits: SlipFits,
): void {
  const d = SLIP_DESIGN;
  const x = (referenceX: number) => slipX(referenceX);
  const y = (referenceY: number) => slipY(referenceY, copy);

  drawSlipWatermark(doc, SLIP_WATERMARKS[copy], copy);

  // the seal, byte-for-byte the reference's own image
  doc.image(pnkSealJpeg(), x(d.sealLeft), y(d.sealTop), {
    width: (d.sealRight - d.sealLeft) * SLIP_SCALE,
    height: (d.sealBottom - d.sealTop) * SLIP_SCALE,
  });

  // title + subtitle, centred in the cell beside the seal
  const titleCellWidth = (d.titleCellRight - d.titleCellLeft) * SLIP_SCALE;
  drawSingleLine(doc, SLIP_TITLE, {
    x: x(d.titleCellLeft),
    width: titleCellWidth,
    baseline: y(d.titleBaseline),
    size: calibri(d.titleSize),
    bold: true,
  });
  drawSingleLine(doc, SLIP_SUBTITLE, {
    x: x(d.titleCellLeft),
    width: titleCellWidth,
    baseline: y(d.subtitleBaseline),
    size: calibri(d.titleSize),
    bold: true,
  });

  // ---- the table: the form's only boundary --------------------------------
  slipRule(doc, x(d.boxLeft), y(d.boxTop), x(d.boxRight), y(d.boxTop));
  slipRule(doc, x(d.boxLeft), y(d.fieldRowBottom), x(d.boxRight), y(d.fieldRowBottom));
  slipRule(doc, x(d.boxLeft), y(d.headerRowBottom), x(d.boxRight), y(d.headerRowBottom));
  slipRule(doc, x(d.boxLeft), y(d.dataRowBottom), x(d.boxRight), y(d.dataRowBottom));
  slipRule(doc, x(d.boxLeft), y(d.boxBottom), x(d.boxRight), y(d.boxBottom));

  // left/right borders span the whole table; the field band's split runs from
  // the top of the table down to the data rule; the four data/header splits
  // start at the field row's bottom, exactly as measured on the reference.
  slipRule(doc, x(d.boxLeft), y(d.boxTop), x(d.boxLeft), y(d.boxBottom));
  slipRule(doc, x(d.boxRight), y(d.boxTop), x(d.boxRight), y(d.boxBottom));
  slipRule(doc, x(d.tableSplit2), y(d.boxTop), x(d.tableSplit2), y(d.dataRowBottom));
  slipRule(doc, x(d.tableSplit4), y(d.boxTop), x(d.tableSplit4), y(d.boxBottom));
  slipRule(doc, x(d.tableSplit1), y(d.fieldRowBottom), x(d.tableSplit1), y(d.dataRowBottom));
  slipRule(doc, x(d.tableSplit3), y(d.fieldRowBottom), x(d.tableSplit3), y(d.dataRowBottom));

  // ---- field band ---------------------------------------------------------
  const fields = slipFieldCells();
  drawSingleLine(doc, SLIP_FIELD_LABELS.pangalan, {
    x: x(d.boxLeft + d.fieldLabelInset),
    baseline: y(d.fieldLabelBaseline),
    size: d.fieldLabelSize,
    bold: true,
  });
  drawSingleLine(doc, SLIP_FIELD_LABELS.tungkulin, {
    x: x(d.tableSplit2 + d.fieldLabelInset),
    baseline: y(d.fieldLabelBaseline),
    size: d.fieldLabelSize,
    bold: true,
  });
  drawSingleLine(doc, SLIP_FIELD_LABELS.weekYear, {
    x: x(d.tableSplit4 + d.fieldLabelInset),
    baseline: y(d.fieldLabelBaseline),
    size: d.fieldLabelSize,
    bold: true,
  });

  drawSingleLine(doc, slip.pangalan, {
    x: x(d.boxLeft + d.fieldValueInset),
    baseline: y(d.fieldValueBaseline),
    size: fits.pangalan,
  });
  drawSingleLine(doc, SLIP_TUNGKULIN, {
    x: fields[1]!.left,
    width: fields[1]!.width,
    baseline: y(d.fieldValueBaseline),
    size: calibri(d.fieldValueBigSize),
  });
  drawSingleLine(doc, slip.weekYear, {
    x: fields[2]!.left,
    width: fields[2]!.width,
    baseline: y(d.fieldValueBaseline),
    size: fits.weekYear,
  });

  // ---- column-header band -------------------------------------------------
  const columns = slipTableColumns();
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i]!;
    const header = SLIP_TABLE_HEADERS[i]!;
    if (header.length === 1) {
      drawSingleLine(doc, header[0]!, {
        x: column.left,
        width: column.width,
        baseline: y(d.headerBaseline),
        size: calibri(d.headerSize),
      });
      continue;
    }
    // the reference's two-line headers: its own measured baselines and sizes
    const receipt = i === 3;
    const size = calibri(receipt ? d.headerSize : d.headerLongSize);
    const baselines = receipt
      ? [d.receiptBaseline1, d.receiptBaseline2]
      : [d.gampaningBaseline1, d.gampaningBaseline2];
    for (let line = 0; line < 2; line++) {
      drawSingleLine(doc, header[line]!, {
        x: column.left,
        width: column.width,
        baseline: y(baselines[line]!),
        size,
      });
    }
  }

  // ---- data row -----------------------------------------------------------
  const data = [slip.dako, slip.petsa, slip.oras, "", slip.gampaning];
  const dataSizes = [fits.dako, fits.petsa, fits.oras, d.dataSize, fits.gampaning];
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i]!;
    drawSingleLine(doc, data[i]!, {
      x: column.left,
      width: column.width,
      baseline: y(d.dataBaseline),
      size: dataSizes[i]!,
    });
  }

  // ---- declaration + Lagda ------------------------------------------------
  for (const run of SLIP_DECLARATION) {
    drawSingleLine(doc, run.text, {
      x: x(run.x),
      baseline: y(run.baseline),
      size: d.declarationSize,
      bold: run.bold,
    });
  }
  drawSingleLine(doc, SLIP_LAGDA_LABEL, {
    x: x(d.tableSplit4 + d.fieldLabelInset),
    baseline: y(d.lagdaBaseline),
    size: d.fieldLabelSize,
    bold: true,
  });

  // ---- signing space below the table --------------------------------------
  slipRule(
    doc,
    x(d.signatureRuleLeft),
    y(d.signatureRuleY),
    x(d.signatureRuleRight),
    y(d.signatureRuleY),
  );
  drawSingleLine(doc, ctx.ministro, {
    x: x(d.signatoryNameLeft),
    baseline: y(d.signatoryNameBaseline),
    size: fits.ministro,
  });
  drawSingleLine(doc, SLIP_SIGNATORY_LABEL, {
    x: x(d.ministroLabelLeft),
    baseline: y(d.ministroBaseline),
    size: calibri(d.ministroSize),
  });

  // ---- revision line ------------------------------------------------------
  drawSingleLine(doc, ctx.footer, {
    x: x(d.footerLeft),
    baseline: y(d.footerBaseline),
    size: d.footerSize,
  });
}

/**
 * Append one page per slip to `doc` (an already-open PDFKit document that holds
 * page 1). Page 1 is not touched: this function only ever calls `addPage`.
 *
 * Each page is `SLIP_PAGE_WIDTH × SLIP_PAGE_HEIGHT`, split into two equal
 * halves, each holding one copy of the same form — the top `ORIGINAL`, the
 * bottom `DUPLICATE` — at identical geometry and identical fitted sizes.
 */
export function renderSuguanSlipPages(
  doc: PDFKit.PDFDocument,
  slips: readonly SuguanSlip[],
  ctx: SuguanSlipContext,
): SuguanSlipRenderResult {
  const oversize: string[] = [];
  for (const slip of slips) {
    // measured once per slip, then reused by BOTH copies
    const fits = fitSlip(doc, slip, ctx, oversize);
    doc.addPage({ size: [SLIP_PAGE_WIDTH, SLIP_PAGE_HEIGHT], margin: 0 });
    drawSlipCopy(doc, 0, slip, ctx, fits);
    drawSlipCopy(doc, 1, slip, ctx, fits);
  }
  return { oversize };
}
