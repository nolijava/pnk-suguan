/**
 * PNK Suguan System logo — build-pipeline pins.
 *
 * SOURCE OF TRUTH: public/logo/ — the hand-supplied Illustrator artwork
 * (theme variants of `pnk-suguan-logo*.svg` plus their 64/256/512 PNG twins
 * and the multi-resolution .ico). Those files are SHIPPED and transparent, and
 * NOTHING in this suite regenerates them: `scripts/generate-logo.mjs` renders
 * into the gitignored `logo-render/` scratch directory and refuses any path
 * under public/logo.
 *
 * `scripts/logo-master.svg` is the vector source the shipped files are derived
 * from. The only thing the pipeline ADDS to the master is the small "PNK"
 * wordmark (Poppins Black, outlined from the TTF) inside the removed
 * lower-right quadrant — navy #1B2A6B for the light theme, near-white #E8EAED
 * for dark. This suite pins the master measurements, the deterministic
 * renderer, the wordmark geometry, and — most importantly — the safety
 * property that a test run cannot overwrite the supplied logo.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..", "..");
const GEN = path.join(ROOT, "scripts", "generate-logo.mjs");
const MASTER = path.join(ROOT, "scripts", "logo-master.svg");
const LOGO_DIR = path.join(ROOT, "public", "logo");
const SCRATCH = path.join(ROOT, "logo-render");

/** The complete published artwork set — exactly what ships (nothing else). */
const SHIPPED_FILES = [
  "pnk-suguan-logo.svg",
  "pnk-suguan-logo-512.png",
  "pnk-suguan-logo-256.png",
  "pnk-suguan-logo-64.png",
  "pnk-suguan-logo-dark.svg",
  "pnk-suguan-logo-dark-512.png",
  "pnk-suguan-logo-dark-256.png",
  "pnk-suguan-logo-dark-64.png",
  "pnk-suguan.ico",
];

interface Png {
  width: number;
  height: number;
  at(x: number, y: number): [number, number, number, number];
}
interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
interface Placed extends BBox {
  d: string;
  capHeight: number;
  glyphs: number;
  OX: number;
  OY: number;
  R: number;
  cx: number;
  cy: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface LogoModule {
  MASTER_PATH: string;
  PUBLIC_DIR: string;
  SCRATCH_DIR: string;
  MARGIN: number;
  SIZES: number[];
  WORDMARK_TEXT: string;
  WORDMARK_CAP_FRACTION: number;
  WORDMARK_COLORS: Record<string, string>;
  flattenPathD(d: string): number[][][];
  parseSvg(svg: string): {
    viewBox: number[];
    paints: Array<{ hex: string; clip: string | null; shape: { kind: string } }>;
    clipPolys: Map<string, number[][][]>;
  };
  measureArtwork(svg: string): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
  normalizeViewBox(svg: string, margin?: number): { svg: string; viewBox: number[]; artwork: ReturnType<LogoModule["measureArtwork"]> };
  typesetWordmark(text?: string, capHeight?: number, origin?: [number, number]): { d: string; bbox: BBox; capHeight: number; glyphs: number };
  placeWordmark(norm: ReturnType<LogoModule["normalizeViewBox"]>, capFraction?: number): Placed;
  composeVariant(norm: ReturnType<LogoModule["normalizeViewBox"]>, theme: string): { svg: string; color: string };
  encodePng(width: number, height: number, rgba: Buffer): Buffer;
  ICO_SIZES: number[];
  renderPng(parsed: ReturnType<LogoModule["parseSvg"]>, size: number): Buffer;
  renderRgba(parsed: ReturnType<LogoModule["parseSvg"]>, size: number): Buffer;
  encodeDib(size: number, rgba: Buffer): Buffer;
  renderIco(parsed: ReturnType<LogoModule["parseSvg"]>): Buffer;
  buildAssets(): {
    files: Map<string, Buffer>;
    shipped: Map<string, Buffer>;
    variants: Record<string, string>;
    parsed: Record<string, ReturnType<LogoModule["parseSvg"]>>;
    wordmark: Placed;
  };
  assertNotPublicDir(outDir: string): void;
  writeAssets(outDir?: string): string[];
  checkAssets(dir?: string): { ok: boolean; drift: string[]; missing: string[]; shipped: Map<string, Buffer> };
}
const gen = (await import(GEN)) as LogoModule;

const master = readFileSync(MASTER, "utf8");
const norm = gen.normalizeViewBox(master);
const lightVariant = gen.composeVariant(norm, "light");
let parsedPng: Png;

/** Decode a generated PNG (filter 0, RGBA) into a pixel accessor. */
function decodePng(buf: Buffer): Png {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  expect(buf[25]).toBe(6); // color type RGBA
  const idats: Buffer[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const ty = buf.toString("ascii", off + 4, off + 8);
    if (ty === "IDAT") idats.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (ty === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const stride = 1 + width * 4;
  return {
    width,
    height,
    at(x: number, y: number): [number, number, number, number] {
      const o = y * stride + 1 + x * 4;
      return [raw[o]!, raw[o + 1]!, raw[o + 2]!, raw[o + 3]!];
    },
  };
}

function readShipped(name: string): Buffer {
  return readFileSync(path.join(LOGO_DIR, name));
}

/** Master-unit coordinates -> pixels of the normalized 512 render. */
function pxOf(mx: number, my: number): [number, number] {
  return [Math.round(mx - norm.viewBox[0]!), Math.round(my - norm.viewBox[1]!)];
}

interface IcoEntry {
  size: number;
  offset: number;
  length: number;
  kind: "png" | "dib";
}

/** Parse an .ico container and validate the shared header fields. */
function parseIco(buf: Buffer): { entries: IcoEntry[]; dirBytes: number } {
  expect(buf.readUInt16LE(0)).toBe(0); // reserved
  expect(buf.readUInt16LE(2)).toBe(1); // type: icon
  const count = buf.readUInt16LE(4);
  const dirBytes = 6 + count * 16;
  const entries: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = buf[e] === 0 ? 256 : buf[e]!;
    expect(buf[e + 1] === 0 ? 256 : buf[e + 1]!).toBe(size); // square entries
    expect(buf.readUInt16LE(e + 4)).toBe(1); // colour planes
    expect(buf.readUInt16LE(e + 6)).toBe(32); // bits per pixel
    const length = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    expect(offset).toBeGreaterThanOrEqual(dirBytes);
    expect(offset + length).toBeLessThanOrEqual(buf.length);
    const isPng = buf.subarray(offset, offset + 8).toString("hex") === "89504e470d0a1a0a";
    entries.push({ size, offset, length, kind: isPng ? "png" : "dib" });
  }
  return { entries, dirBytes };
}

function shippedHashes(): Map<string, string> {
  return new Map(SHIPPED_FILES.map((f) => [f, createHash("sha256").update(readShipped(f)).digest("hex")]));
}

beforeAll(() => {
  parsedPng = decodePng(gen.renderPng(gen.parseSvg(lightVariant.svg), 512));
});

describe("master artwork measurement", () => {
  it("the Illustrator artwork is exactly square", () => {
    const a = gen.measureArtwork(master);
    expect(a.width).toBeCloseTo(a.height, 1);
    // Known bounds of the hand-refined export.
    expect(a.minX).toBeCloseTo(79.09, 1);
    expect(a.minY).toBeCloseTo(0, 1);
    expect(a.maxX).toBeCloseTo(559.04, 1);
    expect(a.maxY).toBeCloseTo(479.95, 1);
  });

  it("flattenPathD flattens lines and Illustrator cubics without loss", () => {
    const polys = gen.flattenPathD("M0,0L10,0 10,10Z M5,5C6,6 7,7 8,8");
    expect(polys).toHaveLength(2);
    expect(polys[0]).toHaveLength(4); // closed triangle: 3 pts + close pt
    expect(polys[1]!.length).toBeGreaterThan(2);
    const last = polys[1]!.at(-1)!;
    expect(last[0]).toBeCloseTo(8);
    expect(last[1]).toBeCloseTo(8);
  });

  it("parser resolves style-class fills, clips and painter order", () => {
    const p = gen.parseSvg(master);
    // 1 yellow path + 57 UR paints (base rect + 56 tiles) + 53 LL paints
    // (base rect + 52 tiles incl. the two corrective jitter tiles).
    expect(p.paints.length).toBe(111);
    expect(p.paints[0]!.hex.toLowerCase()).toBe("#f5b301");
    const clips = new Set(p.paints.map((x) => x.clip));
    expect(clips.has("clippath")).toBe(true);
    expect(clips.has("clippath-1")).toBe(true);
    // Painter's algorithm: yellow corner piece is painted first.
    expect(p.paints[0]!.shape.kind).toBe("path");
  });

  it("normalizeViewBox centers the artwork in a square box with an even margin", () => {
    const [vx, vy, vw, vh] = norm.viewBox;
    expect(vw!).toBeCloseTo(vh!, 3);
    const a = gen.measureArtwork(master);
    const cx = (a.minX + a.maxX) / 2;
    const cy = (a.minY + a.maxY) / 2;
    expect(cx - vx!).toBeCloseTo(vw! / 2, 1);
    expect(cy - vy!).toBeCloseTo(vh! / 2, 1);
    expect(vw).toBeCloseTo(a.width + 2 * gen.MARGIN, 1);
    // Shapes are untouched — only the <svg> attributes change.
    const masterPaths = master.match(/d="[^"]+"/g);
    expect(norm.svg.match(/d="[^"]+"/g)).toEqual(masterPaths);
    const masterRects = master.match(/<rect[^>]*>/g);
    expect(norm.svg.match(/<rect[^>]*>/g)).toEqual(masterRects);
    expect(norm.svg).toContain('width="512"');
  });
});

describe("wordmark typesetting (Poppins Black outlines)", () => {
  it("typesets PNK as closed Poppins contours using only M/L/C/Z", () => {
    const t = gen.typesetWordmark();
    expect(t.glyphs).toBe(3);
    expect((t.d.match(/M/g) ?? []).length).toBe(4); // P stem + bowl, N, K
    expect(t.d).toMatch(/^[MLCZ0-9.,\-\s]+$/); // renderer-supported commands only
    expect(t.d.endsWith("Z")).toBe(true);
    // The cap height IS the ink height: Poppins' capitals span exactly minY..maxY.
    expect(t.bbox.maxY - t.bbox.minY).toBeCloseTo(t.capHeight, 3);
  });

  it("scales linearly and translates the layout origin precisely", () => {
    const small = gen.typesetWordmark("PNK", 20, [0, 0]);
    const big = gen.typesetWordmark("PNK", 30, [0, 0]);
    const ratio = (small.bbox.maxX - small.bbox.minX) / (big.bbox.maxX - big.bbox.minX);
    expect(ratio).toBeCloseTo(20 / 30, 3);
    const moved = gen.typesetWordmark("PNK", 20, [100, 200]);
    expect(moved.bbox.maxX - moved.bbox.minX).toBeCloseTo(small.bbox.maxX - small.bbox.minX, 3);
    expect(moved.bbox.maxY).toBeCloseTo(200, 1); // baseline sits on the origin y
  });

  it("throws for characters outside the font instead of dropping them", () => {
    expect(() => gen.typesetWordmark("PN漢")).toThrow(/no glyph/);
  });

  it("inserts implied on-curve points between the two off-curve controls, not off the last emitted point", () => {
    // The P bowl's shoulder has a run of three consecutive off-curve points
    // in Poppins Black. TrueType inserts an implied on-curve point midway
    // between the two CONTROLS; a past regression used the last EMITTED
    // point, dragging both shoulder midpoints inward (x 69.84/73.73 instead
    // of 79.03/77.99 at cap 100), kinking the bowl into a broken-looking P.
    const { d } = gen.typesetWordmark("P", 100, [0, 0]);
    // First cubic of the outer contour: starts at (50.85,-31.78) climbing to
    // (50.85,-100); its END POINT is the implied midpoint between the second
    // and third raw controls, and must sit at x ≈ 79.03 (mid of 72.48/85.57).
    const c1 = d.match(/C([\d.,\- ]+)/);
    expect(c1).not.toBeNull();
    const nums = (c1![1] ?? "").split(/[ ,]+/).map(Number);
    const midX = nums[4]!;
    const midY = nums[5]!;
    expect(midX).toBeCloseTo(79.03, 1); // was 69.84 with the regression
    expect(midY).toBeCloseTo(-90.68, 1);
    // The bowl's outermost x is the raw extreme point 629 font units
    // (= 88.84 at cap 100); the regression pulled the shoulder well inside.
    const xs = [...d.matchAll(/[\d.]+,/g)].map((m) => Number(m[0].slice(0, -1)));
    const bowlMaxX = Math.max(...xs);
    expect(bowlMaxX).toBeGreaterThan(88);
    expect(bowlMaxX).toBeLessThan(90);
    // The two kink vertices the regression used to emit must be gone.
    expect(d).not.toContain("69.84,-90.68");
    expect(d).not.toContain("73.73,-42.52");
  });
});

describe("wordmark placement in the removed quadrant", () => {
  it("is small next to the mark but legible — a fixed fraction of the quadrant radius", () => {
    const wm = gen.placeWordmark(norm);
    expect(wm.glyphs).toBe(3);
    expect(wm.capHeight).toBeCloseTo(wm.R * gen.WORDMARK_CAP_FRACTION, 1);
    // Legible: caps ≈ 9.5% of the mark width (the original 0.12 fraction gave
    // ~6% — unreadably small, and the design was rejected on review).
    expect(wm.capHeight).toBeGreaterThan(wm.R * 0.18);
    // …but still clearly secondary to the mark: well under the quadrant width.
    expect(wm.right - wm.left).toBeLessThan(wm.R * 0.7);
    // Real side-by-side Poppins Black letterforms: the word's aspect ratio is
    // ≈ 2.99. (A past regression skipped the pen advances and stacked all
    // three glyphs on one spot → ratio ≈ 0.98 and an unreadable blob.)
    const aspect = (wm.right - wm.left) / wm.capHeight;
    expect(aspect).toBeGreaterThan(2.7);
    expect(aspect).toBeLessThan(3.2);
  });

  it("anchors the text centre at 75% across and 75% down the mark", () => {
    const wm = gen.placeWordmark(norm);
    const art = norm.artwork;
    const cx75 = art.minX + 0.75 * (art.maxX - art.minX);
    const cy75 = art.minY + 0.75 * (art.maxY - art.minY);
    expect(wm.cx).toBeCloseTo(cx75, 1);
    expect(wm.cy).toBeCloseTo(cy75, 1);
    // …and the far corner of the box stays inside the rim arc.
    const farCorner = Math.hypot(wm.right - wm.OX, wm.bottom - wm.OY);
    expect(farCorner).toBeLessThanOrEqual(wm.R - 0.5);
    // The K's ink stays clear of the rim (flattened outline, conservative).
    let maxD = 0;
    for (const poly of gen.flattenPathD(wm.d)) {
      for (const p of poly) {
        const x = p[0]!;
        const y = p[1]!;
        maxD = Math.max(maxD, Math.hypot(x - wm.OX, y - wm.OY));
      }
    }
    expect(maxD).toBeLessThan(wm.R);
  });

  it("throws when the requested text cannot fit", () => {
    expect(() => gen.placeWordmark(norm, 0.9)).toThrow(/does not fit/);
  });
});

describe("theme variants — light and dark wordmark", () => {
  it("composeVariant appends the wordmark and changes only its tint", () => {
    const light = gen.composeVariant(norm, "light");
    const dark = gen.composeVariant(norm, "dark");
    expect(light.color.toLowerCase()).toBe("#1b2a6b");
    expect(dark.color.toLowerCase()).toBe("#e8eaed");
    const strip = (s: string) => s.replace(/<g id="wordmark-pnk"[\s\S]*?<\/g>/, "");
    expect(strip(light.svg)).toBe(strip(dark.svg));
    expect(strip(light.svg)).toBe(norm.svg);
    expect(light.svg).toContain("wordmark-pnk");
    expect(() => gen.composeVariant(norm, "sepia")).toThrow(/unknown theme/);
  });

  it("the wordmark renders as a small navy PNK in the light PNG", () => {
    const wm = gen.placeWordmark(norm);
    const [x0, y0] = pxOf(wm.left - 2, wm.top - 2);
    const [x1, y1] = pxOf(wm.right + 2, wm.bottom + 2);
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const [r, g, b, a] = parsedPng.at(x, y)!;
        if (a === 255 && r === 27 && g === 42 && b === 107) n++;
      }
    }
    expect(n).toBeGreaterThan(150); // ~407 solid px measured
    // …and nowhere else in the REMOVED quadrant: no wordmark ink outside its
    // placed box. (The mosaic's own #1b2a6b tiles live in the kept slices, so
    // the scan is limited to the quadrant, past the cut keep-out.)
    const [qx0, qy0] = pxOf(wm.OX + 6, wm.OY + 6);
    let outside = 0;
    for (let y = qy0; y < 512; y += 1) {
      for (let x = qx0; x < 512; x += 1) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
        const [r, g, b, a] = parsedPng.at(x, y)!;
        if (a === 255 && r === 27 && g === 42 && b === 107) outside++;
      }
    }
    expect(outside).toBe(0);
  });

  it("the dark variant renders the same geometry with the near-white tint", () => {
    const a = gen.renderRgba(gen.parseSvg(lightVariant.svg), 512);
    const b = gen.renderRgba(gen.parseSvg(gen.composeVariant(norm, "dark").svg), 512);
    let diffs = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (
        a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]
      ) {
        diffs++;
        // Every differing pixel is exactly the wordmark tint swap.
        expect([a[i], a[i + 1], a[i + 2]]).toEqual([27, 42, 107]);
        expect([b[i], b[i + 1], b[i + 2]]).toEqual([232, 234, 237]);
      }
    }
    expect(diffs).toBeGreaterThan(4000); // the wordmark actually differs
    expect(diffs).toBeLessThan(10000); // …and stays confined to its placed box
  });
});

describe("raster output", () => {
  it("rasterized 512px PNG has even 16px margins on all four sides", () => {
    const W = parsedPng.width;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < parsedPng.height; y++) {
      for (let x = 0; x < W; x++) {
        if (parsedPng.at(x, y)![3]! > 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    const margin = (512 - 480) / 2;
    expect(minX).toBe(Math.round(margin));
    expect(minY).toBe(Math.round(margin));
    expect(W - 1 - maxX).toBe(Math.round(margin));
    expect(parsedPng.height - 1 - maxY).toBe(Math.round(margin));
  });

  it("quadrants land on the approved colors; removed quadrant and cuts are empty", () => {
    const [yx, yy] = pxOf(120, 100); // upper-left corner piece
    const [ux, uy] = pxOf(420, 100); // upper-right kept slice
    const [lx, ly] = pxOf(150, 300); // lower-left kept slice (inside the arc)
    const [rx, ry] = pxOf(420, 400); // removed quadrant (wordmark lives lower-left of this)
    expect(parsedPng.at(yx, yy)).toEqual([245, 179, 1, 255]);
    expect(parsedPng.at(ux, uy)![3]).toBe(255);
    expect(parsedPng.at(lx, ly)![3]).toBe(255);
    expect(parsedPng.at(rx, ry)![3]).toBe(0);
    // The 10-unit cuts along both axes are empty, with ink on both far sides.
    const [c1x, c1y] = pxOf(319, 100); // vertical cut band (x 314.09..324.09)
    const [c2x, c2y] = pxOf(100, 240); // horizontal cut band (y 235..245)
    expect(parsedPng.at(c1x, c1y)![3]).toBe(0);
    expect(parsedPng.at(c2x, c2y)![3]).toBe(0);
    expect(parsedPng.at(pxOf(330, 100)[0]!, pxOf(330, 100)[1]!)![3]).toBe(255); // UR of cut
    expect(parsedPng.at(pxOf(100, 250)[0]!, pxOf(100, 250)[1]!)![3]).toBe(255); // LL below cut
  });

  it("every approved palette shade appears in the render", () => {
    const shades = new Set<string>();
    for (let y = 0; y < 512; y += 2) {
      for (let x = 0; x < 512; x += 2) {
        const [r, g, b, a] = parsedPng.at(x, y)!;
        if (a === 255) shades.add(`${r},${g},${b}`);
      }
    }
    // #3a63b8 (.st3) is deliberately absent: in the export it only occurs in
    // tiles clipped to sub-pixel slivers, so it never renders as a solid px.
    for (const hex of [
      "#f5b301", "#24408e", "#2f56a7", "#1b2a6b",
      "#2d6cdf", "#3e86e0", "#57a4e8", "#6fb9ee", "#3e7edb", "#4b92e0",
    ]) {
      const [r, g, b] = hex.slice(1).match(/../g)!.map((h) => parseInt(h, 16));
      expect(shades.has(`${r},${g},${b}`)).toBe(true);
    }
  });

  it("PNG header encodes the requested square RGBA size", () => {
    const buf = gen.renderPng(gen.parseSvg(lightVariant.svg), 64);
    expect(buf.readUInt32BE(16)).toBe(64);
    expect(buf.readUInt32BE(20)).toBe(64);
    expect(buf[24]).toBe(8);
    expect(buf[25]).toBe(6);
  });
});

describe("shipped artwork — the supplied transparent mark", () => {
  it("publishes exactly the artwork files and no generator scratch", () => {
    expect(readdirSync(LOGO_DIR).sort()).toEqual([...SHIPPED_FILES].sort());
    expect(existsSync(path.join(LOGO_DIR, "preview.html"))).toBe(false);
    expect(existsSync(path.join(LOGO_DIR, "reference.png"))).toBe(false);
  });

  it("each shipped SVG is square, explicitly sized and paints no background", () => {
    for (const name of ["pnk-suguan-logo.svg", "pnk-suguan-logo-dark.svg"]) {
      const svg = readShipped(name).toString("utf8");
      const vb = svg.match(/viewBox="([^"]+)"/)![1]!.split(/\s+/).map(Number);
      expect(vb).toHaveLength(4);
      expect(vb[2]!).toBeCloseTo(vb[3]!, 3); // square
      expect(svg).toContain('width="512"');
      expect(svg).toContain('height="512"');
      // Transparency: the palette is blue + gold only — no white plate, no
      // black ground — and the first painted shape is the gold corner piece,
      // i.e. nothing is drawn behind the mark.
      expect(svg).not.toMatch(/#fff\b|#ffffff|fill="white"|fill="#000/i);
      const p = gen.parseSvg(svg);
      expect(p.paints[0]!.shape.kind).toBe("path");
      expect(p.paints[0]!.hex.toLowerCase()).toBe("#f5b301");
    }
  });

  it("the two variants differ only in the wordmark tint", () => {
    const light = readShipped("pnk-suguan-logo.svg").toString("utf8");
    const dark = readShipped("pnk-suguan-logo-dark.svg").toString("utf8");
    const strip = (s: string) => s.replace(/<g id="wordmark-pnk"[\s\S]*?<\/g>/, "");
    expect(strip(light)).toBe(strip(dark));
    expect(light).toContain('fill="#1B2A6B"');
    expect(dark).toContain('fill="#E8EAED"');
  });

  it("the shipped SVGs are byte-identical to a fresh compose", () => {
    const { files } = gen.buildAssets();
    expect(readShipped("pnk-suguan-logo.svg")).toEqual(files.get("pnk-suguan-logo.svg")!);
    expect(readShipped("pnk-suguan-logo-dark.svg")).toEqual(files.get("pnk-suguan-logo-dark.svg")!);
  });

  it("each shipped PNG is square RGBA with a genuinely transparent background", () => {
    for (const stem of ["pnk-suguan-logo", "pnk-suguan-logo-dark"]) {
      for (const size of gen.SIZES) {
        const buf = readShipped(`${stem}-${size}.png`);
        const png = decodePng(buf);
        expect(png.width).toBe(size);
        expect(png.height).toBe(size);
        expect(buf[24]).toBe(8); // bit depth
        expect(buf[25]).toBe(6); // color type RGBA
        // Corners are outside the mark -> fully transparent (no plate).
        for (const [x, y] of [
          [0, 0],
          [png.width - 1, 0],
          [0, png.height - 1],
          [png.width - 1, png.height - 1],
        ] as const) {
          expect(png.at(x, y)![3]).toBe(0);
        }
        // The mark itself is solid; the surrounding area is clear.
        let opaque = 0;
        let clear = 0;
        for (let y = 0; y < png.height; y++) {
          for (let x = 0; x < png.width; x++) {
            const a = png.at(x, y)![3]!;
            if (a === 255) opaque++;
            else if (a === 0) clear++;
          }
        }
        expect(opaque).toBeGreaterThan(0);
        expect(clear).toBeGreaterThan(0);
      }
    }
  });

  it("the shipped PNG twins stay in sync with the shipped SVGs (icons never go stale)", () => {
    for (const stem of ["pnk-suguan-logo", "pnk-suguan-logo-dark"]) {
      const parsed = gen.parseSvg(readShipped(`${stem}.svg`).toString("utf8"));
      for (const size of gen.SIZES) {
        expect(readShipped(`${stem}-${size}.png`)).toEqual(gen.renderPng(parsed, size));
      }
    }
  });

  it("the shipped .ico is a multi-resolution icon covering every size Windows asks for", () => {
    const buf = readShipped("pnk-suguan.ico");
    const { entries, dirBytes } = parseIco(buf);
    expect(entries.map((e) => e.size)).toEqual(gen.ICO_SIZES);
    expect(gen.ICO_SIZES).toEqual([256, 128, 64, 48, 32, 24, 16]);
    // Largest entry first, and the images fill the file exactly (no padding).
    expect([...gen.ICO_SIZES].sort((a, b) => b - a)).toEqual(gen.ICO_SIZES);
    const last = entries.at(-1)!;
    expect(entries[0]!.offset).toBe(dirBytes);
    expect(last.offset + last.length).toBe(buf.length);
  });

  it("every .ico entry is a real 32-bpp image — PNG for the large sizes, DIB for the rest", () => {
    const buf = readShipped("pnk-suguan.ico");
    const { entries } = parseIco(buf);
    for (const entry of entries) {
      const data = buf.subarray(entry.offset, entry.offset + entry.length);
      if (entry.kind === "png") {
        // PNG is the convention for large entries; the header must agree.
        expect(entry.size).toBeGreaterThanOrEqual(128);
        expect(data.readUInt32BE(16)).toBe(entry.size);
        expect(data.readUInt32BE(20)).toBe(entry.size);
        expect(data[24]).toBe(8);
        expect(data[25]).toBe(6);
      } else {
        const maskStride = Math.ceil(entry.size / 32) * 4;
        expect(entry.length).toBe(40 + entry.size * entry.size * 4 + maskStride * entry.size);
        expect(data.readUInt32LE(0)).toBe(40); // BITMAPINFOHEADER
        expect(data.readInt32LE(4)).toBe(entry.size); // biWidth
        expect(data.readInt32LE(8)).toBe(entry.size * 2); // XOR + AND mask
        expect(data.readUInt16LE(12)).toBe(1); // planes
        expect(data.readUInt16LE(14)).toBe(32); // bpp
        expect(data.readUInt32LE(16)).toBe(0); // BI_RGB
        expect(data.readUInt32LE(20)).toBe(entry.size * entry.size * 4); // biSizeImage
      }
    }
  });

  it("the .ico DIB pixels match the renderer exactly (bottom-up BGRA, alpha intact)", () => {
    const parsed = gen.parseSvg(readShipped("pnk-suguan-logo.svg").toString("utf8"));
    const buf = readShipped("pnk-suguan.ico");
    const entry = parseIco(buf).entries.find((e) => e.size === 32)!;
    const data = buf.subarray(entry.offset, entry.offset + entry.length);
    const rgba = gen.renderRgba(parsed, 32);
    for (const [x, y] of [[0, 0], [8, 8], [16, 8], [16, 16], [31, 31], [2, 20]] as const) {
      const row = 40 + (31 - y) * 32 * 4; // DIB rows run bottom-up
      const px = data.subarray(row + x * 4, row + x * 4 + 4); // B,G,R,A
      const src = (y * 32 + x) * 4;
      expect([px[2], px[1], px[0], px[3]]).toEqual([rgba[src], rgba[src + 1], rgba[src + 2], rgba[src + 3]]);
    }
    // And the encoder is the one the pipeline ships.
    expect(gen.encodeDib(32, rgba)).toEqual(Buffer.from(data));
  });

  it("the shipped .ico stays in sync with the shipped light SVG (the installer icon never goes stale)", () => {
    const parsed = gen.parseSvg(readShipped("pnk-suguan-logo.svg").toString("utf8"));
    expect(readShipped("pnk-suguan.ico")).toEqual(gen.renderIco(parsed));
  });
});

describe("the pipeline cannot overwrite the shipped artwork", () => {
  it("writeAssets() refuses public/logo (and anything inside it)", () => {
    expect(() => gen.writeAssets(LOGO_DIR)).toThrow(/refusing to write into/);
    expect(() => gen.writeAssets(path.join(LOGO_DIR, "nested"))).toThrow(/refusing to write into/);
  });

  it("`npm run logo` renders into logo-render/ and leaves public/logo byte-identical", () => {
    const before = shippedHashes();
    const res = spawnSync(process.execPath, [GEN], { cwd: ROOT, encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/refusing/);
    for (const [file, hash] of before) {
      const after = createHash("sha256").update(readShipped(file)).digest("hex");
      expect(after).toBe(hash);
    }
    // …while still producing the render in the scratch directory.
    expect(existsSync(path.join(SCRATCH, "pnk-suguan-logo.svg"))).toBe(true);
    expect(existsSync(path.join(SCRATCH, "pnk-suguan-logo-dark.svg"))).toBe(true);
    expect(existsSync(path.join(SCRATCH, "preview.html"))).toBe(true);
  });

  it("`--check` reports drift (never fixes it) and never touches public/logo", () => {
    const before = shippedHashes();
    const tmp = mkdtempSync(path.join(os.tmpdir(), "pnk-logo-"));
    try {
      for (const f of SHIPPED_FILES) writeFileSync(path.join(tmp, f), readShipped(f));
      const clean = gen.checkAssets(tmp);
      expect(clean.missing).toEqual([]);

      // A drifted file is REPORTED, and only that file.
      const broken = path.join(tmp, "pnk-suguan-logo-64.png");
      writeFileSync(broken, Buffer.concat([readFileSync(broken), Buffer.from([0])]));
      const dirty = gen.checkAssets(tmp);
      expect(dirty.ok).toBe(false);
      expect(dirty.drift).toEqual(["pnk-suguan-logo-64.png"]);

      // A missing file is reported as missing, not silently re-created.
      rmSync(path.join(tmp, "pnk-suguan-logo.svg"));
      const gone = gen.checkAssets(tmp);
      expect(gone.ok).toBe(false);
      expect(gone.missing).toEqual(["pnk-suguan-logo.svg"]);
      expect(existsSync(path.join(tmp, "pnk-suguan-logo.svg"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    // whichever way --check reports, the shipped files are untouched
    const cli = spawnSync(process.execPath, [GEN, "--check"], { cwd: ROOT, encoding: "utf8" });
    expect([0, 1]).toContain(cli.status);
    for (const [file, hash] of before) {
      expect(createHash("sha256").update(readShipped(file)).digest("hex")).toBe(hash);
    }
  });

  it("buildAssets() renders every asset in memory and ships no preview page", () => {
    const { files, shipped } = gen.buildAssets();
    expect([...files.keys()].sort()).toEqual([...SHIPPED_FILES, "preview.html"].sort());
    expect([...shipped.keys()].sort()).toEqual([...SHIPPED_FILES].sort());
  });
});
