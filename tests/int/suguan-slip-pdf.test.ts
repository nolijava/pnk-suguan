/**
 * Patotoo slip pages — the per-teacher forms APPENDED after page 1 of the
 * Weekly Suguan PDF.
 *
 * Two tiers, deliberately:
 *   • the GEOMETRY CONTRACT is asserted from the exported layout (the same
 *     values the renderer draws with), so a drifted constant fails here rather
 *     than only in a pixel diff;
 *   • the RENDERED PAGE is then parsed — inflated content streams, decoded text
 *     operands, stroked rule segments, transformation matrices — because a claim
 *     about one line per cell, a 45° watermark or two identical copies is only
 *     meaningful in the bytes that get printed.
 *
 * Reference: `Suguan Slip.pdf` (A4, two stacked copies). Every expected
 * coordinate below is a value measured from that file.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { isoWeekDates } from "@/lib/iso-week";
import { resetTestDb, seedAdmin, teardown, db } from "./helpers";
import {
  CALIBRI_STAND_IN,
  SLIP_COPY_HEIGHT,
  SLIP_COPY_TOPS,
  SLIP_DESIGN,
  SLIP_HALF_HEIGHT,
  SLIP_LEFT,
  SLIP_MIN_TEXT_SIZE,
  SLIP_PAGE_HEIGHT,
  SLIP_PAGE_MARGIN,
  SLIP_PAGE_WIDTH,
  SLIP_REFERENCE_CONTENT_HEIGHT,
  SLIP_REFERENCE_CONTENT_TOP,
  SLIP_REFERENCE_CONTENT_WIDTH,
  SLIP_SCALE,
  SLIP_TITLE,
  SLIP_TUNGKULIN,
  SLIP_WATERMARK_ANGLE,
  SLIP_WATERMARKS,
  calibri,
  fitSingleLine,
  renderSuguanSlipPages,
  slipFieldCells,
  slipTableColumns,
  slipX,
  slipY,
  type SuguanSlip,
} from "@/server/services/suguan-slip-pdf.service";
import { PNK_SEAL_BYTES, PNK_SEAL_PIXELS, pnkSealJpeg } from "@/server/services/assets/pnk-seal";
import {
  buildSuguanSlips,
  generateWeeklySuguanPdf,
  renderWeeklySuguanPdf,
  renderWeeklySuguanPdfWithSlips,
} from "@/server/services/weekly-suguan-pdf.service";

// ---------------------------------------------------------------------------
// Reading a rendered page
// ---------------------------------------------------------------------------

/**
 * Every inflated stream. NOT all of them are page content: font programs and
 * the embedded image are flate streams too, so anything that means "the page's
 * drawing instructions" must filter with `drawingStreams`.
 */
function contentStreams(buffer: Buffer): string[] {
  const latin = buffer.toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(latin)) !== null) {
    const start = match.index + match[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      out.push(inflateSync(Buffer.from(latin.slice(start, end), "latin1")).toString("latin1"));
    } catch {
      /* not flate */
    }
  }
  return out;
}

/** Only the streams that actually draw: text blocks or stroked rules. */
function drawingStreams(buffer: Buffer): string[] {
  return contentStreams(buffer).filter((s) => s.includes("BT") || s.includes(" m\n"));
}

interface PaintedRun {
  /** distance from the top of the page, in points */
  y: number;
  x: number;
  size: number;
  text: string;
}

/**
 * Every text run the page paints, with the position and size in force when it
 * was painted. PDFKit writes each run's origin as a text matrix (`Tm`) inside a
 * `BT … ET` block and wraps the page in a single flip (`1 0 0 -1 0 936 cm`), so
 * `fromTop = 936 − Tm.y` — the convention the layout is authored in.
 */
function paintedRuns(buffer: Buffer): PaintedRun[] {
  const runs: PaintedRun[] = [];
  for (const content of contentStreams(buffer)) {
    for (const block of content.split("BT").slice(1)) {
      const body = block.split("ET")[0] ?? block;
      const tm = /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/.exec(body);
      const tf = /\/(\w+) ([\d.]+) Tf/.exec(body);
      if (!tm || !tf) continue;
      let text = "";
      for (const hex of body.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        const clean = hex[1]!;
        for (let i = 0; i + 1 < clean.length; i += 2) {
          text += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
        }
      }
      if (text.trim() === "") continue;
      runs.push({
        y: SLIP_PAGE_HEIGHT - Number(tm[2]),
        x: Number(tm[1]),
        size: Number(tf[2]),
        text,
      });
    }
  }
  return runs;
}

interface PaintedRule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  /** the stroke colour's RGB components in force when the rule was stroked */
  rgb: [number, number, number];
}

/** Every stroked rule segment, with its line width and stroke colour. */
function paintedRules(buffer: Buffer): PaintedRule[] {
  const rules: PaintedRule[] = [];
  for (const content of contentStreams(buffer)) {
    let width = 0;
    let rgb: [number, number, number] = [0, 0, 0];
    const re =
      /([\d.-]+) w|([\d.-]+) ([\d.-]+) ([\d.-]+) SCN|([\d.-]+) ([\d.-]+) m\n([\d.-]+) ([\d.-]+) l\nS/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      if (match[1] !== undefined) {
        width = Number(match[1]);
      } else if (match[2] !== undefined) {
        rgb = [Number(match[2]), Number(match[3]), Number(match[4])];
      } else {
        rules.push({
          x1: Number(match[5]),
          y1: Number(match[6]),
          x2: Number(match[7]),
          y2: Number(match[8]),
          width,
          rgb,
        });
      }
    }
  }
  return rules;
}

/** The rotation of every non-trivial `cm`, in degrees (a,b are cos,sin). */
function paintedRotationAngles(buffer: Buffer): number[] {
  const angles: number[] = [];
  for (const content of contentStreams(buffer)) {
    for (const m of content.matchAll(/([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) cm/g)) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (Math.abs(b) < 1e-6) continue; // not a rotation
      angles.push((Math.atan2(b, a) * 180) / Math.PI);
    }
  }
  return angles;
}

function mediaBoxesOf(buffer: Buffer): string[] {
  return [...buffer.toString("latin1").matchAll(/\/MediaBox \[([^\]]*)\]/g)].map((m) => m[1]!.trim());
}

function jpegSize(jpeg: Buffer): { width: number; height: number } {
  let i = 2; // past SOI
  while (i < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = jpeg[i + 1]!;
    const length = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw new Error("no SOF marker in the embedded JPEG");
}

// ---------------------------------------------------------------------------
// The slip under test
// ---------------------------------------------------------------------------

const SLIP: SuguanSlip = {
  pangalan: "Jay Lorence Famorcan",
  dako: "Beltran",
  weekYear: "36-2026",
  petsa: "09/05/2026",
  oras: "9AM",
  gampaning: "SUGO",
};
const CONTEXT = { ministro: "MCCOY SUATARON", footer: "Revised September 2026" };

/** Render slip pages on their own (PDFKit's implicit first page stays blank). */
function renderSlips(slips: SuguanSlip[], context = CONTEXT): Promise<Buffer> {
  const doc = new PDFDocument({ size: [SLIP_PAGE_WIDTH, SLIP_PAGE_HEIGHT], margin: 0 });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
  renderSuguanSlipPages(doc, slips, context);
  doc.end();
  return done;
}

const near = (actual: number, expected: number, tolerance = 0.02): void => {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
};

describe("patotoo slip pages — geometry contract", () => {
  it("is the app's mandated 8.5 × 13in sheet, cut into two equal halves", () => {
    expect(SLIP_PAGE_WIDTH).toBe(612);
    expect(SLIP_PAGE_HEIGHT).toBe(936);
    expect(SLIP_HALF_HEIGHT).toBe(468);
    // one copy, centred in its half, leaves the same slack above and below
    near(SLIP_COPY_HEIGHT, 351.66, 0.02);
    near(SLIP_COPY_TOPS[0], 58.17, 0.02);
    near(SLIP_COPY_TOPS[1], 526.17, 0.02);
    near(SLIP_COPY_TOPS[1] - SLIP_COPY_TOPS[0], SLIP_HALF_HEIGHT, 1e-9);
    // the copy must stay inside its OWN half — no overlap across the cut
    expect(SLIP_COPY_TOPS[0] + SLIP_COPY_HEIGHT).toBeLessThanOrEqual(SLIP_HALF_HEIGHT);
    expect(SLIP_COPY_TOPS[1] + SLIP_COPY_HEIGHT).toBeLessThanOrEqual(SLIP_PAGE_HEIGHT);
  });

  it("scales the reference copy to fill the width, keeping the reference's own margin", () => {
    expect(SLIP_PAGE_MARGIN).toBe(31.9);
    expect(SLIP_REFERENCE_CONTENT_WIDTH).toBe(531.4);
    near(SLIP_SCALE, 1.031615, 1e-6);
    // the reference's left border lands exactly on the margin, and the right
    // margin mirrors it — so the form is centred and fills the sheet's width
    near(slipX(SLIP_DESIGN.boxLeft), SLIP_PAGE_MARGIN, 1e-9);
    near(slipX(SLIP_DESIGN.signatureRuleRight), SLIP_PAGE_WIDTH - SLIP_PAGE_MARGIN, 1e-9);
    // the copy's own printed height, derived from the reference
    near(SLIP_REFERENCE_CONTENT_HEIGHT, 340.89, 1e-9);
    near(SLIP_REFERENCE_CONTENT_TOP, 24.21, 1e-9);
  });

  it("reproduces the reference's measured rule grid and column boundaries", () => {
    // every value below is measured from Suguan Slip.pdf (copy 1, fromTop)
    expect(SLIP_DESIGN).toMatchObject({
      boxLeft: 31.3,
      boxRight: 562.3,
      boxTop: 89.13,
      fieldRowBottom: 135.53,
      headerRowBottom: 180.95,
      dataRowBottom: 247.55,
      boxBottom: 310.58,
      tableSplit1: 152.15,
      tableSplit2: 262.38,
      tableSplit3: 354.43,
      tableSplit4: 444.65,
      signatureRuleY: 354.78,
      signatureRuleLeft: 354.83,
      signatureRuleRight: 562.7,
    });
    // the field band's three cells and the table's five columns tile the box
    const fields = slipFieldCells();
    const columns = slipTableColumns();
    expect(fields).toHaveLength(3);
    expect(columns).toHaveLength(5);
    near(
      fields.reduce((sum, c) => sum + c.width, 0),
      columns.reduce((sum, c) => sum + c.width, 0),
      1e-9,
    );
    near(fields[2]!.right, columns[4]!.right, 1e-9);
    // and they are the reference's own proportions, not equal quarters
    expect(columns[0]!.width).toBeGreaterThan(columns[1]!.width);
    expect(columns[2]!.width).not.toBeCloseTo(columns[0]!.width, 0);
  });

  it("stands Helvetica in for the reference's Calibri at the reference's PRINTED width", () => {
    // The reference sets the title, field values, headers, ministro label and
    // signatory name in Calibri; measured against the reference's own strings
    // Calibri advances ≈0.865× Helvetica's, so those runs are drawn smaller in
    // order to print the same width. Arial-based runs (labels, data row,
    // declaration, footer) are metric-compatible with Helvetica and keep their
    // measured sizes unchanged.
    expect(CALIBRI_STAND_IN).toBeGreaterThan(0.8);
    expect(CALIBRI_STAND_IN).toBeLessThan(0.95);
    expect(calibri(SLIP_DESIGN.titleSize)).toBeCloseTo(10.38, 2);
    expect(calibri(SLIP_DESIGN.headerSize)).toBeCloseTo(13.84, 2);
    expect(SLIP_DESIGN.dataSize).toBe(14);
    expect(SLIP_DESIGN.declarationSize).toBe(12);
    expect(SLIP_DESIGN.fieldLabelSize).toBe(11);
  });

  it("takes every y from the reference's measured baselines", () => {
    expect(SLIP_DESIGN).toMatchObject({
      titleBaseline: 41.8,
      subtitleBaseline: 72.4,
      fieldLabelBaseline: 103.63,
      fieldValueBaseline: 129.42,
      headerBaseline: 163.63,
      receiptBaseline1: 153.42,
      receiptBaseline2: 173.83,
      gampaningBaseline1: 154.42,
      gampaningBaseline2: 170.02,
      dataBaseline: 219.25,
      lagdaBaseline: 259.05,
      declarationBaseline1: 267.85,
      declarationBaseline2: 283.08,
      declarationBaseline3: 298.47,
      signatoryNameBaseline: 346.67,
      ministroBaseline: 348.67,
      footerBaseline: 363.08,
    });
    // both copies are the same form: a reference y maps to y and y + 468
    for (const referenceY of [SLIP_DESIGN.boxTop, SLIP_DESIGN.dataBaseline, SLIP_DESIGN.footerBaseline]) {
      near(slipY(referenceY, 1) - slipY(referenceY, 0), SLIP_HALF_HEIGHT, 1e-9);
    }
  });
});

describe("patotoo slip pages — fitting one line per cell", () => {
  const LONG = "Juan Carlos de la Cruz Villanueva Sarmiento Pangilinan";

  it("keeps the reference size when the value fits and shrinks it when it does not", async () => {
    const doc = new PDFDocument({ size: [SLIP_PAGE_WIDTH, SLIP_PAGE_HEIGHT], margin: 0 });
    const size = calibri(SLIP_DESIGN.fieldValueNameSize);
    const width = slipFieldCells()[0]!.width - 10;
    // a name the reference itself prints keeps the full size
    expect(fitSingleLine(doc, "Jay Lorence Famorcan", { font: "Helvetica", size, width })).toBe(size);
    // a much longer one is fitted DOWN — never wrapped, never ellipsized
    const fitted = fitSingleLine(doc, LONG, { font: "Helvetica", size, width });
    expect(fitted).toBeLessThan(size);
    expect(doc.fontSize(fitted).widthOfString(LONG)).toBeLessThanOrEqual(width);
    expect(fitted).toBeGreaterThanOrEqual(SLIP_MIN_TEXT_SIZE);
    doc.end();
  });

  it("never reduces a value below the minimum readable size, but reports it", async () => {
    const buffer = await renderSlips([
      { ...SLIP, pangalan: "Juan Carlos de la Cruz Villanueva Sarmiento Pangilinan Delos Reyes Bautista" },
    ]);
    const runs = paintedRuns(buffer).filter((r) => r.text.startsWith("Juan Carlos"));
    expect(runs).toHaveLength(2); // once per copy
    for (const run of runs) {
      expect(run.size).toBeGreaterThanOrEqual(SLIP_MIN_TEXT_SIZE);
      expect(run.text).not.toContain("…"); // never ellipsized
    }
  });

  it("shrinks the font, never the cell: the printed grid is identical for short and long names", async () => {
    const longName = "Juan Carlos de la Cruz Villanueva Sarmiento";
    const short = paintedRuns(await renderSlips([SLIP]));
    const long = paintedRuns(await renderSlips([{ ...SLIP, pangalan: longName }]));
    // Every run EXCEPT the teacher's name must be identical — same text, same
    // position, same size. Only the name's font size may differ.
    const grid = (runs: PaintedRun[], teacher: string) =>
      runs
        .filter((r) => r.text !== teacher)
        .map((r) => `${r.text}@${r.y.toFixed(2)},${r.x.toFixed(2)},${r.size.toFixed(2)}`);
    expect(grid(long, longName)).toEqual(grid(short, SLIP.pangalan));
    // ...and the long value really was fitted down
    const longRun = long.find((r) => r.text === longName)!;
    const shortRun = short.find((r) => r.text === SLIP.pangalan)!;
    expect(longRun.size).toBeLessThan(shortRun.size);
  });

  it("prints every populated cell on exactly one line, in both copies", async () => {
    const slip = { ...SLIP, pangalan: "Juan Carlos de la Cruz Villanueva Sarmiento", dako: "Arenda Extension" };
    const runs = paintedRuns(await renderSlips([slip]));
    // one run per VALUE per copy: a wrapped value would paint two runs
    for (const value of [slip.pangalan, slip.dako, slip.weekYear, slip.petsa, slip.oras, slip.gampaning]) {
      const hits = runs.filter((r) => r.text === value);
      expect(hits, `${value} should be painted once per copy`).toHaveLength(2);
    }
    // the fixed labels the form always prints, once per copy
    for (const label of [SLIP_TITLE, SLIP_TUNGKULIN, "Pangalan:", "Tungkulin:", "Week - Year:", "Lagda:"]) {
      expect(runs.filter((r) => r.text === label), label).toHaveLength(2);
    }
  });
});

describe("patotoo slip pages — the rendered page", () => {
  it("is 612 × 936 for every page, with two copies per slip", async () => {
    const buffer = await renderSlips([SLIP, { ...SLIP, gampaning: "RESERBA" }]);
    const boxes = mediaBoxesOf(buffer);
    // PDFKit's implicit first page plus one page per slip
    expect(boxes.length).toBe(3);
    for (const box of boxes) expect(box).toBe(`0 0 ${SLIP_PAGE_WIDTH} ${SLIP_PAGE_HEIGHT}`);
  });

  it("draws 1pt black rules that land on the reference's grid", async () => {
    const rules = paintedRules(await renderSlips([SLIP]));
    expect(rules).toHaveLength(24); // 12 rules × the two copies
    for (const rule of rules) {
      expect(rule.width).toBe(1);
      expect(rule.rgb).toEqual([0, 0, 0]);
    }
    const horizontals = rules.filter((r) => r.y1 === r.y2).map((r) => r.y1).sort((a, b) => a - b);
    const verticals = rules.filter((r) => r.x1 === r.x2).map((r) => r.x1).sort((a, b) => a - b);
    expect(horizontals).toHaveLength(12); // 6 per copy
    expect(verticals).toHaveLength(12);
    const expectedY = [
      SLIP_DESIGN.boxTop,
      SLIP_DESIGN.fieldRowBottom,
      SLIP_DESIGN.headerRowBottom,
      SLIP_DESIGN.dataRowBottom,
      SLIP_DESIGN.boxBottom,
      SLIP_DESIGN.signatureRuleY,
    ].flatMap((y) => [slipY(y, 0), slipY(y, 1)]);
    for (const y of expectedY) {
      const hit = horizontals.filter((h) => Math.abs(h - y) < 0.02);
      expect(hit, `no rule within 0.02pt of ${y}`).toHaveLength(1);
    }
  });

  it("makes the DUPLICATE copy the ORIGINAL copy shifted by exactly one half", async () => {
    const buffer = await renderSlips([SLIP]);
    const runs = paintedRuns(buffer);
    const rules = paintedRules(buffer);
    const half = SLIP_HALF_HEIGHT;
    const watermarks = SLIP_WATERMARKS as readonly string[];
    for (const run of runs) {
      // the watermark is the ONE intended difference between the copies
      if (run.y < half && !watermarks.includes(run.text)) {
        const twin = runs.find(
          (r) => r.text === run.text && Math.abs(r.x - run.x) < 1e-6 && Math.abs(r.y - run.y - half) < 0.02,
        );
        expect(twin, `${run.text} has no copy at +468`).toBeDefined();
        expect(twin!.size).toBe(run.size); // identical fitted size, not re-fitted
      }
    }
    for (const rule of rules) {
      if (rule.y1 < half) {
        const twin = rules.find(
          (r) => Math.abs(r.x1 - rule.x1) < 0.02 && Math.abs(r.y1 - rule.y1 - half) < 0.02,
        );
        expect(twin, `rule at y=${rule.y1} has no copy at +468`).toBeDefined();
      }
    }
    // nothing crosses the cut: the top copy ends above it, the bottom starts below
    expect(Math.max(...runs.filter((r) => r.y < half).map((r) => r.y))).toBeLessThan(half);
    expect(Math.min(...runs.filter((r) => !watermarks.includes(r.text) && r.y > half).map((r) => r.y))).toBeGreaterThan(half);
    expect(Math.max(...rules.filter((r) => r.y1 < half).map((r) => r.y1))).toBeLessThan(half);
  });

  it("carries the assignment data in both copies, identically", async () => {
    const buffer = await renderSlips([SLIP]);
    const runs = paintedRuns(buffer);
    const at = (text: string) => runs.filter((r) => r.text === text);
    for (const value of [SLIP.pangalan, SLIP.dako, SLIP.weekYear, SLIP.petsa, SLIP.oras, SLIP.gampaning]) {
      const hits = at(value);
      expect(hits, value).toHaveLength(2);
      expect(hits[0]!.x).toBeCloseTo(hits[1]!.x, 6);
      expect(hits[0]!.y + SLIP_HALF_HEIGHT).toBeCloseTo(hits[1]!.y, 6);
    }
    // the receipt number has no source and is left blank on the form
    expect(runs.some((r) => r.text.includes("RESIBO") && r.text !== "RESIBO")).toBe(false);
  });

  it("watermarks ORIGINAL on the top copy and DUPLICATE on the bottom, each rotated exactly 45°", async () => {
    const buffer = await renderSlips([SLIP]);
    const marks = paintedRuns(buffer).filter((r) =>
      (SLIP_WATERMARKS as readonly string[]).includes(r.text),
    );
    expect(marks).toHaveLength(2);
    const original = marks.find((m) => m.text === "ORIGINAL")!;
    const duplicate = marks.find((m) => m.text === "DUPLICATE")!;
    expect(original.y).toBeLessThan(SLIP_HALF_HEIGHT); // top copy only
    expect(duplicate.y).toBeGreaterThan(SLIP_HALF_HEIGHT); // bottom copy only
    near(duplicate.y - original.y, SLIP_HALF_HEIGHT, 0.02);
    // both rotations are the same angle, and it is exactly the specified one
    const angles = paintedRotationAngles(buffer);
    expect(angles).toHaveLength(2);
    for (const angle of angles) expect(Math.abs(angle)).toBeCloseTo(SLIP_WATERMARK_ANGLE, 9);
    // the reference's form text is never rotated, and DRAFT never appears
    expect(paintedRuns(buffer).some((r) => r.text.includes("DRAFT"))).toBe(false);
    expect(buffer.toString("latin1")).not.toContain("DRAFT");
  });

  it("prints the view model's revision line, never the reference's own revision", async () => {
    const buffer = await renderSlips([SLIP]);
    const runs = paintedRuns(buffer);
    expect(runs.filter((r) => r.text === CONTEXT.footer)).toHaveLength(2);
    expect(runs.some((r) => r.text.includes("2020"))).toBe(false);
    // the reference's label, with the signatory the app already owns
    expect(runs.filter((r) => r.text === "Ministrong Nagklase:")).toHaveLength(2);
    expect(runs.filter((r) => r.text === CONTEXT.ministro)).toHaveLength(2);
  });

  it("embeds the reference's seal byte-for-byte, at the reference's measured position", async () => {
    const seal = pnkSealJpeg();
    expect(seal.length).toBe(PNK_SEAL_BYTES);
    expect(jpegSize(seal)).toEqual({ width: PNK_SEAL_PIXELS.width, height: PNK_SEAL_PIXELS.height });
    expect(createHash("sha256").update(seal).digest("hex")).toBe(
      "2ceda4c4bbf9b3b71a62180603551148897e0a19353390f12956ff6b59ae1d9e",
    );
    const buffer = await renderSlips([SLIP]);
    // placed by the same `cm` scale the reference uses, once per copy, and the
    // JPEG is embedded verbatim (DCTDecode = the original bytes)
    expect(buffer.toString("latin1")).toContain("/DCTDecode");
    const placements = contentStreams(buffer)
      .join("\n")
      .match(/[\d.]+ 0 0 -?[\d.]+ [\d.]+ [\d.]+ cm\n\/I\d+ Do/g) ?? [];
    expect(placements).toHaveLength(2);
    for (const placement of placements) {
      const scale = placement.split(" ");
      near(Number(scale[0]), (SLIP_DESIGN.sealRight - SLIP_DESIGN.sealLeft) * SLIP_SCALE, 0.01);
      near(Number(scale[3]!), -(SLIP_DESIGN.sealBottom - SLIP_DESIGN.sealTop) * SLIP_SCALE, 0.01);
    }
  });
});

// ---------------------------------------------------------------------------
// The document: page 1 untouched, slips appended from the week's own data
// ---------------------------------------------------------------------------

describe("patotoo slip pages — data from the week's view model", () => {
  let adminId: string;

  beforeEach(async () => {
    await resetTestDb();
    adminId = await seedAdmin();
  });

  afterAll(async () => {
    await teardown();
  });

  async function mkTeacher(code: string, name = code) {
    const rows = await db
      .insert(schema.teachers)
      .values({ teacherCode: code, firstName: name, lastName: code, language: "FILIPINO" })
      .returning();
    return rows[0]!;
  }
  async function mkDako(code: string, worshipTime = "09:00") {
    const rows = await db
      .insert(schema.dako)
      .values({
        dakoCode: code,
        name: `Dako ${code}`,
        address: "Addr",
        dateEstablished: "2000-01-01",
        worshipDay: "SUNDAY",
        worshipTime,
        language: "FILIPINO",
      })
      .returning();
    return rows[0]!;
  }
  async function mkWeek(year: number, isoWeekNumber: number) {
    const { startDate, endDate } = isoWeekDates(year, isoWeekNumber);
    const rows = await db
      .insert(schema.weeks)
      .values({ year, isoWeekNumber, startDate, endDate, status: "DRAFT" })
      .returning();
    return rows[0]!;
  }
  async function assign(weekId: string, dakoId: string, teacherId: string, type: string) {
    await db.insert(schema.assignments).values({
      weekId,
      dakoId,
      teacherId,
      assignmentType: type,
      assignmentSource: "AUTO",
      status: "ASSIGNED",
    });
  }

  it("makes ONE slip per assigned row, in A → B → C order, skipping unassigned dakos", async () => {
    const week = await mkWeek(2090, 12);
    const dakos = [await mkDako("S1"), await mkDako("S2"), await mkDako("S3")];
    for (const [i, dako] of dakos.entries()) {
      if (i < 2) await assign(week.id, dako.id, (await mkTeacher(`T${i}`)).id, "SUGO");
      if (i === 0) await assign(week.id, dako.id, (await mkTeacher(`R${i}`)).id, "RESERBA");
      if (i === 0) await assign(week.id, dako.id, (await mkTeacher(`C${i}`)).id, "RESERBA_II");
    }

    const vm = await (await import("@/server/services/weekly-suguan-pdf.service")).buildWeeklySuguanViewModel(week.id);
    const slips = buildSuguanSlips(vm);
    expect(slips).toHaveLength(4); // 2 SUGO + 1 RESERBA + 1 RESERBA II
    expect(slips.map((s) => s.gampaning)).toEqual(["SUGO", "SUGO", "RESERBA", "RESERBA II"]);
    // the unassigned dako never becomes a slip, and nothing is invented for it
    expect(slips.every((s) => s.pangalan !== null && s.pangalan !== "")).toBe(true);
    expect(slips.map((s) => s.dako)).toEqual(["Dako S1", "Dako S2", "Dako S1", "Dako S1"]);
  });

  it("prints Week - Year and PETSA from the week's own row — never today's date", async () => {
    const weekA = await mkWeek(2026, 36);
    await assign(weekA.id, (await mkDako("WA")).id, (await mkTeacher("TA")).id, "SUGO");
    const weekB = await mkWeek(2027, 1);
    await assign(weekB.id, (await mkDako("WB")).id, (await mkTeacher("TB")).id, "SUGO");

    const service = await import("@/server/services/weekly-suguan-pdf.service");
    for (const [week, weekYear, petsa] of [
      [weekA, "36-2026", "09/06/2026"],
      [weekB, "1-2027", "01/10/2027"], // ISO W1 2027 runs Mon 4 Jan – Sun 10 Jan
    ] as const) {
      const vm = await service.buildWeeklySuguanViewModel(week.id);
      const slips = buildSuguanSlips(vm);
      expect(slips).toHaveLength(1);
      expect(slips[0]!.weekYear).toBe(weekYear);
      expect(slips[0]!.petsa).toBe(petsa); // MM/DD/YYYY, the week's Sunday
    }
  });

  it("prints the stored dako name and the compact worship time", async () => {
    const week = await mkWeek(2091, 20);
    const dako = await mkDako("AZ", "08:30");
    await assign(week.id, dako.id, (await mkTeacher("TZ")).id, "RESERBA");
    const vm = await (await import("@/server/services/weekly-suguan-pdf.service")).buildWeeklySuguanViewModel(week.id);
    const slips = buildSuguanSlips(vm);
    expect(slips[0]!.dako).toBe("Dako AZ"); // as stored, not uppercased/abbreviated
    expect(slips[0]!.oras).toBe("8:30AM"); // the existing presentation helper
    expect(slips[0]!.gampaning).toBe("RESERBA");
  });

  it("appends one page per slip while page 1 stays byte-for-byte the same", async () => {
    const week = await mkWeek(2092, 22);
    for (let i = 0; i < 3; i++) {
      const dako = await mkDako(`P${i}`);
      await assign(week.id, dako.id, (await mkTeacher(`TP${i}`)).id, "SUGO");
    }
    const vm = await (await import("@/server/services/weekly-suguan-pdf.service")).buildWeeklySuguanViewModel(week.id);
    const pageOne = await renderWeeklySuguanPdf(vm);
    const withSlips = await renderWeeklySuguanPdfWithSlips(vm);

    expect(withSlips.slips).toHaveLength(3);
    expect(mediaBoxesOf(withSlips.buffer)).toHaveLength(4); // page 1 + 3 slips
    // page 1's drawing instructions are present VERBATIM in the combined
    // document — the same calls, in the same order, byte-for-byte
    const combined = drawingStreams(withSlips.buffer);
    const pageOneStreams = drawingStreams(pageOne);
    expect(pageOneStreams).toHaveLength(1);
    expect(combined).toContain(pageOneStreams[0]);
    expect(combined).toHaveLength(4); // page 1 + one stream per slip page
    // and each appended page carries its own ORIGINAL/DUPLICATE pair
    const marks = paintedRuns(withSlips.buffer).filter((r) => (SLIP_WATERMARKS as readonly string[]).includes(r.text));
    expect(marks.filter((m) => m.text === "ORIGINAL")).toHaveLength(3);
    expect(marks.filter((m) => m.text === "DUPLICATE")).toHaveLength(3);
    expect(withSlips.oversize).toEqual([]);
    void adminId;
  });

  it("generating the PDF mutates nothing", async () => {
    const week = await mkWeek(2093, 23);
    const dako = await mkDako("Q1");
    await assign(week.id, dako.id, (await mkTeacher("TQ")).id, "SUGO");
    const count = async (table: string) =>
      (await db.execute(sql.raw(`select count(*)::int as n from ${table}`)))[0]!.n as number;
    const before = {
      assignments: await count("assignments"),
      history: await count("assignment_history"),
      availability: await count("teacher_availability"),
      audit: await count("audit_logs"),
      teachers: await count("teachers"),
      dako: await count("dako"),
      weeks: await count("weeks"),
    };
    const { buffer, slips } = await generateWeeklySuguanPdf(week.id);
    expect(slips).toHaveLength(1);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect({
      assignments: await count("assignments"),
      history: await count("assignment_history"),
      availability: await count("teacher_availability"),
      audit: await count("audit_logs"),
      teachers: await count("teachers"),
      dako: await count("dako"),
      weeks: await count("weeks"),
    }).toEqual(before);
  });
});
