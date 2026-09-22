/**
 * R1 — render the release documentation to PDF.
 *
 * Source of truth:  docs/release/1.0.1/<NAME>.md   (editable Markdown, committed)
 * Output:           release/PNK-Suguan-1.0.1/<NAME>.pdf
 *
 * Purpose: a DOCUMENTATION-GENERATION tool. It is deliberately NOT part of the
 * packaged application payload and is never included in the installer, so it
 * cannot affect production runtime behaviour. It renders with PDFKit's built-in
 * core fonts only (Helvetica / Courier) — no font or asset is downloaded, no
 * network request is made, and no dependency beyond what the project already
 * has is required.
 *
 * The PDFs are written UNCOMPRESSED on purpose: the files stay small, the text
 * layer is greppable (so a reviewer can verify a claim with a text search), and
 * `%PDF`/`%%EOF` structure is trivially inspectable.
 *
 * Usage:
 *   node node_modules/tsx/dist/cli.mjs scripts/generate-release-docs-pdf.ts
 *   node node_modules/tsx/dist/cli.mjs scripts/generate-release-docs-pdf.ts --src <file.md> --out <file.pdf>
 *   node node_modules/tsx/dist/cli.mjs scripts/generate-release-docs-pdf.ts NAME [NAME...]
 *
 * With no arguments it renders the six approved user-facing guides.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const ROOT = path.resolve(import.meta.dirname, "..");
const RELEASE_VERSION = process.env.PNK_RELEASE_VERSION ?? "1.0.1";
const SRC_DIR = path.join(ROOT, "docs", "release", RELEASE_VERSION);
const OUT_DIR = path.join(ROOT, "release", `PNK-Suguan-${RELEASE_VERSION}`);

/** The guides that ship as PDF. CHECKLIST.md/README/RELEASE-NOTES are text. */
const DEFAULT_GUIDES = [
  "INSTALLATION-GUIDE",
  "FIRST-RUN-ADMINISTRATOR-GUIDE",
  "USER-ROLE-GUIDE",
  "OPERATIONS-GUIDE",
  "DATA-PRESERVATION-AND-BACKUP",
  "TROUBLESHOOTING",
];

const DOC_IDENTITY = `PNK Suguan ${RELEASE_VERSION}`;

// ── palette (matches the application's Sacred Minimal tokens) ───────────────
const NAVY = "#172033";
const SLATE = "#5F6878";
const BLUE = "#3B82F6";
const GOLD = "#C9A227";
const BORDER = "#E4E2DC";
const CODEBG = "#F0EFEA";
const HEADBG = "#EDF2FA";
const CODEFG = "#263044";

// ── character handling ───────────────────────────────────────────────────────
/**
 * PDFKit's core fonts are encoded with the standard PDF/WinAnsi set, which does
 * not contain every glyph the Markdown may use. Rather than silently emit
 * garbage, non-encodable characters are transliterated here and anything still
 * unsupported is counted and reported (so a future edit cannot quietly lose
 * text).
 */
const SUBSTITUTIONS: Readonly<Record<string, string>> = {
  "\u2192": "->", // →
  "\u2500": "-", // ─
  "\u251c": "|", // ├
  "\u2514": "`", // └
  "\u2420": " ", // ␠
  "\u2248": "~", // ≈
  "\u2265": ">=", // ≥
  "\u2264": "<=", // ≤
  "\u00d7": "x", // ×
  "\u2713": "-", // ✓
  "\u00a0": " ", // nbsp
};

/** Characters above U+007F that WinAnsi can encode, so they survive as-is. */
const WINANSI_SAFE = new Set(["—", "–", "…", "«", "»", "’", "‘", "“", "”", "•", "·", "°"]);

let unsupportedCount = 0;
const unsupportedChars = new Set<string>();

function sanitize(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 127) {
      out += ch;
      continue;
    }
    const mapped = SUBSTITUTIONS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if (WINANSI_SAFE.has(ch)) {
      out += ch;
      continue;
    }
    unsupportedCount += 1;
    unsupportedChars.add(ch);
    out += "?";
  }
  return out;
}

// ── markdown block model ─────────────────────────────────────────────────────
type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; lines: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" };

const TABLE_SEPARATOR = /^\|[\s\-|:]+\|$/;
const ORDERED_ITEM = /^\d+\.\s+/;
const BULLET_ITEM = /^[-*]\s+/;

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let i = 0;

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ kind: "p", text: para.join(" ") });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("```")) {
      flushPara();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) buf.push(lines[i++] ?? "");
      i += 1;
      blocks.push({ kind: "code", lines: buf });
      continue;
    }

    if (/^#\s+/.test(line)) {
      flushPara();
      blocks.push({ kind: "h1", text: line.replace(/^#\s+/, "").trim() });
      i += 1;
      continue;
    }
    if (/^##\s+/.test(line)) {
      flushPara();
      blocks.push({ kind: "h2", text: line.replace(/^##\s+/, "").trim() });
      i += 1;
      continue;
    }
    if (/^###\s+/.test(line)) {
      flushPara();
      blocks.push({ kind: "h3", text: line.replace(/^###\s+/, "").trim() });
      i += 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      flushPara();
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    if (line.startsWith("|")) {
      flushPara();
      const raw: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("|")) raw.push(lines[i++] ?? "");
      const rows = raw
        .filter((r) => !TABLE_SEPARATOR.test(r))
        .map((r) =>
          r
            .replace(/^\|/, "")
            .replace(/\|\s*$/, "")
            .split("|")
            .map((c) => c.trim()),
        )
        .filter((r) => r.length > 0);
      if (rows.length > 0) blocks.push({ kind: "table", rows });
      continue;
    }

    if (BULLET_ITEM.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && BULLET_ITEM.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(BULLET_ITEM, "").trim());
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (ORDERED_ITEM.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && ORDERED_ITEM.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(ORDERED_ITEM, "").trim());
        i += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    if (line.startsWith(">")) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        buf.push((lines[i] ?? "").replace(/^>\s?/, "").trim());
        i += 1;
      }
      blocks.push({ kind: "quote", lines: buf });
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      i += 1;
      continue;
    }

    para.push(line.trim());
    i += 1;
  }

  flushPara();
  return blocks;
}

// ── inline markdown: **bold** and `mono` ─────────────────────────────────────
interface Seg {
  text: string;
  bold: boolean;
  mono: boolean;
}

function parseInline(text: string): Seg[] {
  const segs: Seg[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index), bold: false, mono: false });
    const token = m[0];
    if (token.startsWith("**")) {
      segs.push({ text: token.slice(2, -2), bold: true, mono: false });
    } else {
      segs.push({ text: token.slice(1, -1), bold: false, mono: true });
    }
    last = m.index + token.length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), bold: false, mono: false });
  return segs.filter((s) => s.text.length > 0);
}

const stripInline = (s: string) => sanitize(s.replace(/\*\*/g, "").replace(/`/g, ""));

// ── renderer ────────────────────────────────────────────────────────────────
async function renderGuide(srcFile: string, outFile: string): Promise<{ pages: number; bytes: number }> {
  const markdown = readFileSync(srcFile, "utf8");
  const blocks = parseBlocks(markdown);

  const doc = new PDFDocument({
    size: "A4",
    compress: false,
    // Buffered pages are required to stamp a footer on every page and to count
    // them accurately; without this only the current page is addressable.
    bufferPages: true,
    margins: { top: 56, bottom: 64, left: 50, right: 50 },
    info: {
      Title: `${path.basename(srcFile, ".md")} — ${DOC_IDENTITY}`,
      Author: DOC_IDENTITY,
      Subject: "Release documentation",
      Keywords: "PNK Suguan, release, documentation",
    },
  });

  mkdirSync(path.dirname(outFile), { recursive: true });
  const stream = createWriteStream(outFile);
  doc.pipe(stream);
  // The write stream is asynchronous: resolve only once it has flushed and
  // closed, otherwise the size reported here would be a partial file.
  const written = new Promise<number>((resolve, reject) => {
    stream.on("close", () => resolve(statSync(outFile).size));
    stream.on("error", reject);
  });

  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - left - doc.page.margins.right;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
  const ensureSpace = (h: number) => {
    if (doc.y + h > bottomLimit()) doc.addPage();
  };

  const wrap = (text: string, width: number, font: string, size: number): string[] => {
    doc.font(font).fontSize(size);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const out: string[] = [];
    let cur = "";
    for (const w of words) {
      const candidate = cur.length > 0 ? `${cur} ${w}` : w;
      if (doc.widthOfString(candidate) <= width) {
        cur = candidate;
      } else {
        if (cur.length > 0) out.push(cur);
        cur = w;
      }
    }
    if (cur.length > 0) out.push(cur);
    return out.length > 0 ? out : [""];
  };

  /** Draw text with inline bold/mono runs, wrapping across lines. */
  const drawRich = (
    text: string,
    opts: { size?: number; x?: number; width?: number; color?: string } = {},
  ): void => {
    const size = opts.size ?? 9.6;
    const x = opts.x ?? left;
    const width = opts.width ?? contentWidth - (x - left);
    const segs = parseInline(sanitize(text));
    if (segs.length === 0) return;

    ensureSpace(size * 2.6);
    doc.x = x;
    doc.y = Math.max(doc.y, doc.page.margins.top);
    segs.forEach((s, idx) => {
      doc
        .font(s.mono ? "Courier" : s.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(s.mono ? size - 0.8 : size)
        .fillColor(s.bold ? NAVY : (opts.color ?? NAVY));
      doc.text(s.text, {
        continued: idx < segs.length - 1,
        width,
        lineGap: 2.4,
      });
    });
    doc.x = left;
  };

  const drawTable = (rows: string[][]): void => {
    const first = rows[0];
    if (first === undefined) return;
    const cols = first.length;
    const pad = 4.5;
    const size = 8.3;
    const lineH = size + 3;

    // Column widths proportional to the longest cell, clamped so one wide
    // column cannot squeeze the others to nothing.
    const longest: number[] = [];
    for (let c = 0; c < cols; c += 1) {
      let max = 1;
      for (const r of rows) max = Math.max(max, stripInline(r[c] ?? "").length);
      longest.push(Math.min(Math.max(max, 10), 64));
    }
    const totalWeight = longest.reduce((a, b) => a + b, 0);
    const widths = longest.map((w) => (w / totalWeight) * contentWidth);

    const cellLines = rows.map((r) =>
      Array.from({ length: cols }, (_, c) => {
        const width = (widths[c] ?? contentWidth / cols) - pad * 2;
        return wrap(stripInline(r[c] ?? ""), width, "Helvetica", size);
      }),
    );
    const heights = cellLines.map((ls) => {
      const maxLines = ls.reduce((acc, l) => Math.max(acc, l.length), 1);
      return maxLines * lineH + pad * 2;
    });

    ensureSpace((heights[0] ?? 20) + (heights[1] ?? 20));
    let y = doc.y;
    rows.forEach((_row, r) => {
      const h = heights[r] ?? lineH;
      if (y + h > bottomLimit()) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      if (r === 0) {
        doc.save().rect(left, y, contentWidth, h).fill(HEADBG).restore();
      }
      let x = left;
      for (let c = 0; c < cols; c += 1) {
        const w = widths[c] ?? contentWidth / cols;
        doc.save().lineWidth(0.6).rect(x, y, w, h).strokeColor(BORDER).stroke().restore();
        doc
          .font(r === 0 ? "Helvetica-Bold" : "Helvetica")
          .fontSize(size)
          .fillColor(r === 0 ? NAVY : SLATE);
        let ty = y + pad - 1;
        for (const ln of cellLines[r]?.[c] ?? []) {
          doc.text(ln, x + pad, ty, { lineBreak: false });
          ty += lineH;
        }
        x += w;
      }
      y += h;
    });
    doc.y = y + 10;
    doc.x = left;
  };

  const drawCode = (lines: string[]): void => {
    const size = 8.3;
    const lineH = size + 3.2;
    const flat: string[] = [];
    lines.forEach((l, idx) => {
      const wrapped = l.length > 0 ? wrap(sanitize(l), contentWidth - 26, "Courier", size) : [""];
      flat.push(...wrapped);
      if (idx < lines.length - 1 && (lines[idx + 1] ?? "").length > 0) flat.push("");
    });
    const h = flat.length * lineH + 14;
    ensureSpace(h);
    const y = doc.y;
    doc.save().rect(left, y, contentWidth, h).fill(CODEBG).restore();
    doc.save().rect(left, y, 2.5, h).fill(GOLD).restore();
    doc.font("Courier").fontSize(size).fillColor(CODEFG);
    let ty = y + 8;
    for (const ln of flat) {
      if (ln.length > 0) doc.text(ln, left + 12, ty, { lineBreak: false });
      ty += lineH;
    }
    doc.y = y + h + 10;
    doc.x = left;
  };

  let titleDrawn = false;

  for (const b of blocks) {
    switch (b.kind) {
      case "h1": {
        const text = sanitize(b.text);
        if (!titleDrawn) {
          titleDrawn = true;
          doc.font("Helvetica-Bold").fontSize(19).fillColor(NAVY).text(text, left, doc.page.margins.top + 6);
          doc.font("Helvetica").fontSize(9.5).fillColor(SLATE).text(
            `${DOC_IDENTITY} — release documentation (source: ${path.basename(srcFile)})`,
            left,
            doc.y + 2,
          );
          doc.save().rect(left, doc.y + 8, 46, 2.5).fill(GOLD).restore();
          doc.y += 22;
          doc.x = left;
        } else {
          ensureSpace(34);
          doc.y += 6;
          doc.font("Helvetica-Bold").fontSize(14).fillColor(NAVY).text(text, left, doc.y, { lineGap: 2 });
          doc.x = left;
          doc.y += 4;
        }
        break;
      }
      case "h2": {
        ensureSpace(40);
        doc.y += 10;
        doc.font("Helvetica-Bold").fontSize(12.5).fillColor(NAVY).text(sanitize(b.text), left, doc.y, {
          lineGap: 2,
        });
        doc.save().rect(left, doc.y + 3, contentWidth, 0.7).fill(BORDER).restore();
        doc.x = left;
        doc.y += 8;
        break;
      }
      case "h3": {
        ensureSpace(30);
        doc.y += 7;
        doc.font("Helvetica-Bold").fontSize(10.8).fillColor(NAVY);
        doc.text(sanitize(b.text), left, doc.y, { lineGap: 2 });
        doc.x = left;
        doc.y += 3;
        break;
      }
      case "p": {
        drawRich(b.text);
        doc.y += 5;
        break;
      }
      case "ul": {
        for (const item of b.items) {
          ensureSpace(16);
          doc.save().circle(left + 4, doc.y + 5.4, 1.5).fill(BLUE).restore();
          drawRich(item, { x: left + 13, width: contentWidth - 13 });
        }
        doc.y += 5;
        doc.x = left;
        break;
      }
      case "ol": {
        b.items.forEach((item, idx) => {
          ensureSpace(16);
          doc.font("Helvetica-Bold").fontSize(9.2).fillColor(BLUE);
          doc.text(`${idx + 1}.`, left + 1, doc.y, { lineBreak: false });
          drawRich(item, { x: left + 18, width: contentWidth - 18 });
        });
        doc.y += 5;
        doc.x = left;
        break;
      }
      case "quote": {
        ensureSpace(30);
        const y = doc.y;
        const text = b.lines.join(" ").trim();
        drawRich(text, { x: left + 14, size: 9.0, color: SLATE, width: contentWidth - 14 });
        doc
          .save()
          .moveTo(left + 2, y)
          .lineTo(left + 2, doc.y)
          .lineWidth(2)
          .strokeColor(GOLD)
          .stroke()
          .restore();
        doc.y += 7;
        doc.x = left;
        break;
      }
      case "code":
        drawCode(b.lines);
        break;
      case "table":
        drawTable(b.rows);
        break;
      case "hr": {
        ensureSpace(14);
        doc.save().rect(left, doc.y + 4, contentWidth, 0.7).fill(BORDER).restore();
        doc.y += 14;
        doc.x = left;
        break;
      }
    }
  }

  // ── footers ────────────────────────────────────────────────────────────────
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p += 1) {
    doc.switchToPage(p);
    // The footer is drawn *below* the text area, and PDFKit starts a new page
    // whenever a drawn line would fall past the bottom margin — which would
    // silently double the page count. Relax the bottom margin for the stamp and
    // restore it immediately afterwards.
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 20;
    doc.y = doc.page.height - 42;
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(SLATE)
      .text(
        `${path.basename(srcFile, ".md")} · ${DOC_IDENTITY} · page ${p - range.start + 1} of ${range.count}`,
        left,
        doc.page.height - 42,
        { width: contentWidth, align: "center", lineBreak: false },
      );
    doc.page.margins.bottom = originalBottomMargin;
  }

  doc.end();
  const bytes = await written;
  return { pages: range.count, bytes };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

const explicitSrc = argValue("--src");
const explicitOut = argValue("--out");

interface Job {
  src: string;
  out: string;
  name: string;
}

let jobs: Job[];

if (explicitSrc !== undefined && explicitOut !== undefined) {
  jobs = [
    {
      src: path.resolve(ROOT, explicitSrc),
      out: path.resolve(ROOT, explicitOut),
      name: path.basename(explicitSrc, ".md"),
    },
  ];
} else {
  const values = new Set([explicitSrc, explicitOut].filter((v): v is string => v !== undefined));
  const names = argv.filter((a) => !a.startsWith("--") && !values.has(a));
  const wanted = names.length > 0 ? names : DEFAULT_GUIDES;
  jobs = wanted.map((name) => ({
    name,
    src: path.join(SRC_DIR, `${name}.md`),
    out: path.join(OUT_DIR, `${name}.pdf`),
  }));
}

async function main(): Promise<void> {
  console.log(`PNK Suguan release documentation — PDF render (${jobs.length} document(s))`);
  console.log("");

  let failed = false;
for (const job of jobs) {
  if (!existsSync(job.src)) {
    console.error(`  FAIL  source not found: ${path.relative(ROOT, job.src)}`);
    failed = true;
    continue;
  }
  const { pages, bytes } = await renderGuide(job.src, job.out);
  console.log(
    `  ok    ${job.name}.pdf  ${pages} page(s), ${(bytes / 1024).toFixed(1)} KB  <- ${path.relative(ROOT, job.src)}`,
  );
}

console.log("");
if (unsupportedCount > 0) {
  console.log(
    `  note  ${unsupportedCount} character(s) were transliterated: ${[...unsupportedChars].join(" ")}`,
  );
}
  console.log(`  output  ${path.relative(ROOT, OUT_DIR)}`);
  if (failed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
