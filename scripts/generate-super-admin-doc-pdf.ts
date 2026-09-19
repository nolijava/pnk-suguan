/**
 * Renders the SUPER_ADMIN section of docs/setup.md as a styled PDF
 * (public/docs/super-admin-setup.pdf). Run:
 *   node node_modules/tsx/dist/cli.mjs scripts/generate-super-admin-doc-pdf.ts
 *
 * The content is parsed from docs/setup.md at generation time, so the PDF can
 * never drift from the documentation. Regenerate after editing that section.
 */
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "public", "docs", "super-admin-setup.pdf");

// ── palette (matches the application design system) ─────────────────────────
const NAVY = "#172033";
const SLATE = "#5F6878";
const BLUE = "#3B82F6";
const GOLD = "#C9A227";
const BORDER = "#E4E2DC";
const CODEBG = "#F0EFEA";
const HEADBG = "#EDF2FA";
const CODEFG = "#263044";

// ── extract the section from the source doc ─────────────────────────────────
const source = readFileSync(path.join(ROOT, "docs", "setup.md"), "utf8");
const startIdx = source.indexOf("## SUPER_ADMIN:");
if (startIdx < 0) {
  console.error("[pdf] SUPER_ADMIN section not found in docs/setup.md");
  process.exit(1);
}
const rest = source.slice(startIdx);
const nextH2 = rest.indexOf("\n## ", 1);
const section = (nextH2 < 0 ? rest : rest.slice(0, nextH2)).trimEnd();

// ── parse into blocks ────────────────────────────────────────────────────────
type Block =
  | { kind: "p"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "code"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "quote"; text: string };

const blocks: Block[] = [];
const lines = section.split("\n");
let i = 1; // skip the "## SUPER_ADMIN:" heading itself (title covers it)
let para: string[] = [];
const flushPara = () => {
  if (para.length) {
    blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  }
};
while (i < lines.length) {
  const line = lines[i]!;
  if (line.startsWith("### ")) {
    flushPara();
    blocks.push({ kind: "h3", text: line.slice(4).trim() });
    i++;
  } else if (line.startsWith("```")) {
    flushPara();
    const buf: string[] = [];
    i++;
    while (i < lines.length && !lines[i]!.startsWith("```")) buf.push(lines[i++]!);
    i++;
    blocks.push({ kind: "code", lines: buf });
  } else if (line.startsWith("|")) {
    flushPara();
    const rows: string[] = [];
    while (i < lines.length && lines[i]!.startsWith("|")) rows.push(lines[i++]!);
    const parsed = rows
      .filter((r) => !/^\|[\s\-|:]+\|$/.test(r))
      .map((r) => r.slice(1, -1).split("|").map((c) => c.trim()));
    blocks.push({ kind: "table", rows: parsed });
  } else if (line.startsWith("- ")) {
    flushPara();
    const items: string[] = [];
    while (i < lines.length && lines[i]!.startsWith("- ")) items.push(lines[i++]!.slice(2).trim());
    blocks.push({ kind: "ul", items });
  } else if (line.startsWith("> ")) {
    flushPara();
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.startsWith("> ")) buf.push(lines[i++]!.slice(2).trim());
    blocks.push({ kind: "quote", text: buf.join(" ") });
  } else if (line.trim() === "") {
    flushPara();
    i++;
  } else {
    para.push(line.trim());
    i++;
  }
}
flushPara();

// ── document setup ───────────────────────────────────────────────────────────
const doc = new PDFDocument({
  size: "A4",
  // Uncompressed: the document is tiny, and it keeps the text layer greppable
  // and the file trivially inspectable/diffable.
  compress: false,
  margins: { top: 56, bottom: 64, left: 50, right: 50 },
  info: { Title: "SUPER_ADMIN Setup — PNK Suguan System", Author: "PNK Suguan System" },
});
mkdirSync(path.dirname(OUT), { recursive: true });
doc.pipe(createWriteStream(OUT));

const left = doc.page.margins.left;
const contentWidth = doc.page.width - left - doc.page.margins.right;
const bottomLimit = () => doc.page.height - doc.page.margins.bottom;

const ensureSpace = (h: number) => {
  if (doc.y + h > bottomLimit()) doc.addPage();
};

// inline **bold** / `mono` parser
type Seg = { text: string; bold?: boolean; mono?: boolean };
function parseInline(s: string): Seg[] {
  const segs: Seg[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) segs.push({ text: s.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith("**")) segs.push({ text: t.slice(2, -2), bold: true });
    else segs.push({ text: t.slice(1, -1), mono: true });
    last = m.index + t.length;
  }
  if (last < s.length) segs.push({ text: s.slice(last) });
  return segs.filter((s) => s.text.length > 0);
}

function drawRich(
  text: string,
  opts: { size?: number; color?: string; x?: number; width?: number } = {},
) {
  const size = opts.size ?? 9.5;
  const x = opts.x ?? left;
  ensureSpace(size * 2.4);
  const segs = parseInline(text);
  if (!segs.length) return;
  doc.x = x;
  doc.y = Math.max(doc.y, doc.page.margins.top);
  segs.forEach((s, idx) => {
    doc
      .font(s.mono ? "Courier" : s.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(size)
      .fillColor(s.bold ? NAVY : (opts.color ?? NAVY));
    doc.text(s.text, {
      continued: idx < segs.length - 1,
      width: opts.width ?? contentWidth - (x - left),
      lineGap: 2.2,
    });
  });
  doc.x = left;
}

function wrapText(text: string, width: number, font: string, size: number): string[] {
  doc.font(font).fontSize(size);
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (doc.widthOfString(cand) <= width) cur = cand;
    else {
      if (cur) out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

const stripInline = (s: string) => s.replace(/\*\*/g, "").replace(/`/g, "");

function drawTable(rows: string[][]) {
  const cols: number[] = [100, 195, 105, 95];
  const pad = 4;
  const size = 8.2;
  const lineH = size + 2.8;
  const cellLines = rows.map((r) =>
    r.map((c, ci) => wrapText(stripInline(c), cols[ci]! - pad * 2, "Helvetica", size)),
  );
  const heights = cellLines.map(
    (ls) => Math.max(...ls.map((l) => l.length), 1) * lineH + pad * 2,
  );
  ensureSpace(heights[0]! + heights[1]!);
  let y = doc.y;
  rows.forEach((_, r) => {
    const h = heights[r]!;
    if (y + h > bottomLimit()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (r === 0) {
      doc.save().rect(left, y, contentWidth, h).fill(HEADBG).restore();
    }
    let x = left;
    rows[r]!.forEach((__, c) => {
      doc.save().lineWidth(0.6).rect(x, y, cols[c]!, h).strokeColor(BORDER).stroke().restore();
      doc
        .font(r === 0 ? "Helvetica-Bold" : "Helvetica")
        .fontSize(size)
        .fillColor(r === 0 ? NAVY : SLATE);
      let ty = y + pad - 1;
      cellLines[r]![c]!.forEach((ln) => {
        doc.text(ln, x + pad, ty, { lineBreak: false });
        ty += lineH;
      });
      x += cols[c]!;
    });
    y += h;
  });
  doc.y = y + 10;
  doc.x = left;
}

function drawCode(lines: string[]) {
  const size = 8.2;
  const lineH = size + 3;
  const wrapped = lines.map((l) =>
    l.length ? wrapText(l, contentWidth - 24, "Courier", size) : [""],
  );
  const flat: string[] = [];
  wrapped.forEach((ls, idx) => {
    flat.push(...ls);
    if (idx < wrapped.length - 1 && lines[idx + 1]!.length) flat.push("");
  });
  const h = flat.length * lineH + 14;
  ensureSpace(h);
  const y = doc.y;
  doc.save().rect(left, y, contentWidth, h).fill(CODEBG).restore();
  doc.save().rect(left, y, 2.5, h).fill(GOLD).restore();
  doc.font("Courier").fontSize(size).fillColor(CODEFG);
  let ty = y + 8;
  flat.forEach((ln) => {
    if (ln) doc.text(ln, left + 12, ty, { lineBreak: false });
    ty += lineH;
  });
  doc.y = y + h + 10;
  doc.x = left;
}

// ── title block ──────────────────────────────────────────────────────────────
doc
  .font("Helvetica-Bold")
  .fontSize(19)
  .fillColor(NAVY)
  .text("SUPER_ADMIN Setup", left, doc.page.margins.top + 6);
doc.font("Helvetica").fontSize(9.5).fillColor(SLATE).text(
  "Provisioning · unlock secret · password recovery — PNK Suguan System (docs/setup.md)",
  left,
  doc.y + 2,
);
doc.save().rect(left, doc.y + 8, 46, 2.5).fill(GOLD).restore();
doc.y += 20;
doc.x = left;

// ── render blocks ────────────────────────────────────────────────────────────
for (const b of blocks) {
  if (b.kind === "h3") {
    ensureSpace(30);
    doc.y += 8;
    doc.font("Helvetica-Bold").fontSize(11.5).fillColor(NAVY);
    doc.text(b.text, left, doc.y, { lineGap: 2 });
    doc.x = left;
    doc.y += 4;
  } else if (b.kind === "p") {
    drawRich(b.text);
    doc.y += 5;
  } else if (b.kind === "ul") {
    for (const item of b.items) {
      ensureSpace(16);
      doc.save().circle(left + 4, doc.y + 5.2, 1.4).fill(BLUE).restore();
      drawRich(item, { x: left + 13, width: contentWidth - 13 });
    }
    doc.y += 5;
    doc.x = left;
  } else if (b.kind === "quote") {
    ensureSpace(30);
    const y = doc.y;
    drawRich(b.text, { x: left + 14, size: 8.8, color: SLATE, width: contentWidth - 14 });
    doc
      .save()
      .moveTo(left + 2, y)
      .lineTo(left + 2, doc.y)
      .lineWidth(2)
      .strokeColor(GOLD)
      .stroke()
      .restore();
    doc.y += 6;
    doc.x = left;
  } else if (b.kind === "code") {
    drawCode(b.lines);
  } else if (b.kind === "table") {
    drawTable(b.rows);
  }
}

// ── footers ──────────────────────────────────────────────────────────────────
const range = doc.bufferedPageRange();
for (let p = range.start; p < range.start + range.count; p++) {
  doc.switchToPage(p);
  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor(SLATE)
    .text(
      `SUPER_ADMIN Setup · PNK Suguan System · page ${p - range.start + 1} of ${range.count}`,
      left,
      doc.page.height - 42,
      { width: contentWidth, align: "center", lineBreak: false },
    );
}

doc.end();
console.log(`[pdf] wrote ${OUT}`);
