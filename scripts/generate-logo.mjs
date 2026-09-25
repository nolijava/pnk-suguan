/**
 * PNK Suguan System — logo build pipeline.
 *
 * SOURCE OF TRUTH: public/logo/ — the hand-supplied artwork (the Illustrator
 * export `pnk-suguan-logo.svg` plus its 64/256/512 PNG twins). Those files are
 * SHIPPED, and this script never writes them: it renders into the gitignored
 * `logo-render/` scratch directory only and refuses any path under public/logo
 * outright. `scripts/logo-master.svg` is the vector source the raster twins and
 * the shipped SVG are derived from; when the master changes, copy the scratch
 * output over public/logo deliberately (or run --check to see the drift).
 *
 * Why the guard exists: an earlier revision of this script wrote straight into
 * public/logo and the unit test invoked it, so a plain `npm test` silently
 * overwrote the supplied artwork. assertNotPublicDir() makes that impossible.
 *
 * Pipeline (every output goes to logo-render/):
 *   1. read scripts/logo-master.svg
 *   2. rebalance its viewBox: the Illustrator export keeps the full artboard
 *      (875.32 x 874.89) while the visible artwork is exactly square
 *      (479.95 x 479.95, spanning x 79.09..559.04, y 0..479.95), so the mark
 *      renders small and off-centre. The artwork bbox is measured from the
 *      painted shapes intersected with their clip paths, and the viewBox is
 *      replaced with a square box that centres the mark with a 16-unit
 *      margin on all four sides. No shape geometry is touched.
 *   3. typeset the small "PNK" wordmark (Poppins Black, converted to outlines
 *      from scripts/fonts/Poppins-Black.ttf — OFL license, see
 *      scripts/fonts/OFL.txt) inside the removed lower-right space of the
 *      rebalanced box, and emit one variant per theme:
 *        light theme: pnk-suguan-logo.svg      (text #1B2A6B — reads on light)
 *        dark theme:  pnk-suguan-logo-dark.svg (text #E8EAED — reads on dark)
 *      The mark itself is identical in both; only the text tint changes.
 *   4. rasterize each variant to 512 / 256 / 64 px PNGs (4x supersampled,
 *      un-premultiplied edges) with the stdlib scanline renderer below
 *   5. write pnk-suguan.ico — the multi-resolution Windows icon (16…256) the
 *      installer embeds and the shortcuts point at (light-variant artwork)
 *   6. write preview.html with every asset inlined
 *
 * The renderer supports exactly the SVG features the variants use: <style>
 * class fills, <clipPath> defs, nested <g> clip inheritance, <rect>, and
 * M/L/H/V/C/Z paths. The wordmark is pre-outlined (TrueType quadratics are
 * converted to exact cubics), so <text>, gradients, images and arcs stay
 * deliberately unsupported. Everything is deterministic, so the unit tests
 * can pin the rendered bytes.
 *
 * Usage:
 *   node scripts/generate-logo.mjs           # render into logo-render/
 *   node scripts/generate-logo.mjs --check    # compare that render against the
 *                                             # shipped public/logo files,
 *                                             # exit 1 on drift, writes nothing
 *   (also `npm run logo`, `npm run logo -- --check`)
 * Zero dependencies beyond node stdlib, like every other script in this repo.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* 0. Paths & constants                                                */
/* ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
export const MASTER_PATH = path.join(HERE, "logo-master.svg");
/** The shipped, hand-supplied artwork directory. NEVER written by this script. */
export const PUBLIC_DIR = path.join(ROOT, "public", "logo");
/** Gitignored scratch render target (`npm run logo`) — see .gitignore. */
export const SCRATCH_DIR = path.join(ROOT, "logo-render");
/** ViewBox margin around the artwork on all four sides, in master units. */
export const MARGIN = 16;
export const SIZES = [512, 256, 64];

const SEGMENTS_PER_CUBIC = 48; // cubic flattening fidelity for rasterization

/* ------------------------------------------------------------------ */
/* 1. SVG subset parsing                                               */
/* ------------------------------------------------------------------ */

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const COMMAND = /([MmLlHhVvCcZz])([^MmLlHhVvCcZz]*)/g;

function numbers(s) {
  return s.match(NUM)?.map(Number) ?? [];
}

function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

/**
 * Flatten an SVG path (M m L l H h V v C c Z z) into polygons
 * ([[x, y], ...] per subpath, closing edges included). Throws on any other
 * command so an unexpectedly fancy master fails loudly instead of rendering
 * subtly wrong.
 */
export function flattenPathD(d) {
  const polys = [];
  let cur = null;
  let sx = 0, sy = 0, x = 0, y = 0;
  for (const [, cmd, argStr] of d.matchAll(COMMAND)) {
    const n = numbers(argStr);
    if (cmd === "M" || cmd === "m") {
      if (cur) polys.push(cur);
      for (let i = 0; i + 1 < n.length; i += 2) {
        x = cmd === "M" ? n[i] : x + n[i];
        y = cmd === "M" ? n[i + 1] : y + n[i + 1];
        if (i === 0) {
          cur = [[x, y]];
          sx = x;
          sy = y;
        } else {
          cur.push([x, y]);
        }
      }
    } else if (!cur) {
      throw new Error(`path command ${cmd} before M`);
    } else if (cmd === "L" || cmd === "l") {
      for (let i = 0; i + 1 < n.length; i += 2) {
        x = cmd === "L" ? n[i] : x + n[i];
        y = cmd === "L" ? n[i + 1] : y + n[i + 1];
        cur.push([x, y]);
      }
    } else if (cmd === "H" || cmd === "h") {
      for (const v of n) {
        x = cmd === "H" ? v : x + v;
        cur.push([x, y]);
      }
    } else if (cmd === "V" || cmd === "v") {
      for (const v of n) {
        y = cmd === "V" ? v : y + v;
        cur.push([x, y]);
      }
    } else if (cmd === "C" || cmd === "c") {
      for (let i = 0; i + 5 < n.length; i += 6) {
        const p1 = cmd === "C" ? [n[i], n[i + 1]] : [x + n[i], y + n[i + 1]];
        const p2 = cmd === "C" ? [n[i + 2], n[i + 3]] : [x + n[i + 2], y + n[i + 3]];
        const p3 = cmd === "C" ? [n[i + 4], n[i + 5]] : [x + n[i + 4], y + n[i + 5]];
        for (let s = 1; s <= SEGMENTS_PER_CUBIC; s++) {
          cur.push(cubicPoint([x, y], p1, p2, p3, s / SEGMENTS_PER_CUBIC));
        }
        x = cmd === "C" ? n[i + 4] : x + n[i + 4];
        y = cmd === "C" ? n[i + 5] : y + n[i + 5];
      }
    } else if (cmd === "Z" || cmd === "z") {
      cur.push([sx, sy]);
      polys.push(cur);
      cur = null;
    }
  }
  if (cur) polys.push(cur);
  return polys;
}

function polysBBox(polys) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function parseStyleClasses(svg) {
  const body = svg.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
  const map = new Map();
  for (const [, cls, props] of body.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
    const entry = {};
    const fill = props.match(/fill:\s*(#[0-9a-fA-F]{3,8}|none)/)?.[1];
    if (fill) entry.fill = fill;
    const clip = props.match(/clip-path:\s*url\(\s*#([\w-]+)\s*\)/)?.[1];
    if (clip) entry.clipPath = clip;
    map.set(cls, entry);
  }
  return map;
}

function parseClipPathDefs(svg) {
  const map = new Map();
  for (const [, id, d] of svg.matchAll(
    /<clipPath\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<path\b[^>]*?\bd="([^"]+)"/g,
  )) {
    map.set(id, d);
  }
  return map;
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
}

function attrsOf(str) {
  const out = {};
  for (const [, k, v] of str.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[k] = v;
  return out;
}

/**
 * Parse the master into an ordered paint list (painter's algorithm order):
 * every visible <rect>/<path> with its resolved fill and nearest ancestor
 * clip. Also returns the flattened clip polygons with their bboxes.
 */
export function parseSvg(svg) {
  const vb = svg.match(/viewBox="([^"]+)"/)?.[1];
  if (!vb) throw new Error("SVG has no viewBox");
  const viewBox = vb.trim().split(/[\s,]+/).map(Number);
  const classes = parseStyleClasses(svg);
  const clipDefs = parseClipPathDefs(svg);
  const clipPolys = new Map();
  const clipBBox = new Map();
  for (const [id, d] of clipDefs) {
    const polys = flattenPathD(d);
    clipPolys.set(id, polys);
    clipBBox.set(id, polysBBox(polys));
  }

  const paints = [];
  let defsDepth = 0;
  const stack = []; // clip id (or null) per open <g>

  const TAG = /<(\/?)([\w:]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const [, close, name, attrStr] of svg.matchAll(TAG)) {
    if (close) {
      if (name === "defs") defsDepth--;
      else if (name === "g") stack.pop();
      continue;
    }
    if (name === "defs") {
      defsDepth++;
      continue;
    }
    if (defsDepth > 0) continue;
    const a = attrsOf(attrStr);
    if (name === "g") {
      const clip =
        a["clip-path"]?.match(/url\(\s*#([\w-]+)\s*\)/)?.[1] ??
        (a.class ? classes.get(a.class)?.clipPath : undefined) ??
        null;
      stack.push(clip);
      continue;
    }
    if (name === "path" || name === "rect") {
      const fill =
        a.fill && a.fill !== "none"
          ? a.fill
          : a.class
            ? classes.get(a.class)?.fill
            : undefined;
      if (!fill || fill === "none") continue;
      const clip = [...stack].reverse().find((c) => c !== null) ?? null;
      const shape =
        name === "rect"
          ? { kind: "rect", x: Number(a.x), y: Number(a.y), w: Number(a.width), h: Number(a.height) }
          : { kind: "path", polys: flattenPathD(a.d) };
      paints.push({ hex: fill, rgb: hexToRgb(fill), clip, shape });
    }
  }
  return { viewBox, paints, clipPolys, clipBBox };
}

/* ------------------------------------------------------------------ */
/* 2. ViewBox rebalancing                                              */
/* ------------------------------------------------------------------ */

const r4 = (v) => Number(v.toFixed(4));

/**
 * Bounding box of the VISIBLE artwork: every painted shape intersected with
 * its clip (rects are clipped away by the quarter-disk clip paths, so the
 * huge Illustrator mosaic rects do not inflate the box).
 */
export function measureArtwork(svg) {
  const parsed = parseSvg(svg);
  let box = null;
  for (const p of parsed.paints) {
    const sb =
      p.shape.kind === "rect"
        ? { minX: p.shape.x, minY: p.shape.y, maxX: p.shape.x + p.shape.w, maxY: p.shape.y + p.shape.h }
        : polysBBox(p.shape.polys);
    const cb = p.clip ? parsed.clipBBox.get(p.clip) : null;
    const vis = cb
      ? {
          minX: Math.max(sb.minX, cb.minX),
          minY: Math.max(sb.minY, cb.minY),
          maxX: Math.min(sb.maxX, cb.maxX),
          maxY: Math.min(sb.maxY, cb.maxY),
        }
      : sb;
    if (vis.maxX > vis.minX && vis.maxY > vis.minY) {
      box = box
        ? {
            minX: Math.min(box.minX, vis.minX),
            minY: Math.min(box.minY, vis.minY),
            maxX: Math.max(box.maxX, vis.maxX),
            maxY: Math.max(box.maxY, vis.maxY),
          }
        : vis;
    }
  }
  if (!box) throw new Error("no visible artwork found");
  return {
    minX: r4(box.minX),
    minY: r4(box.minY),
    maxX: r4(box.maxX),
    maxY: r4(box.maxY),
    width: r4(box.maxX - box.minX),
    height: r4(box.maxY - box.minY),
  };
}

/**
 * Replace the viewBox with a square box that centres the artwork with
 * `margin` units of padding on all four sides. Shapes are untouched.
 */
export function normalizeViewBox(svg, margin = MARGIN) {
  const art = measureArtwork(svg);
  const side = r4(Math.max(art.width, art.height));
  const cx = (art.minX + art.maxX) / 2;
  const cy = (art.minY + art.maxY) / 2;
  const viewBox = [
    r4(cx - side / 2 - margin),
    r4(cy - side / 2 - margin),
    r4(side + 2 * margin),
    r4(side + 2 * margin),
  ];
  if (!/viewBox="/.test(svg)) throw new Error("master SVG has no viewBox to rebalance");
  let out = svg.replace(/viewBox="[^"]*"/, `viewBox="${viewBox.join(" ")}"`);
  // Give the public file explicit square pixel dimensions too.
  const px = Math.round(side + 2 * margin);
  if (!/<svg[^>]*\swidth="/.test(out)) {
    out = out.replace(/<svg\b([^>]*)>/, `<svg$1 width="${px}" height="${px}">`);
  }
  return { svg: out, viewBox, artwork: art };
}

/* ------------------------------------------------------------------ */
/* 2b. Wordmark — "PNK" typeset from Poppins Black into the removed    */
/*     lower-right quadrant                                            */
/* ------------------------------------------------------------------ */

/**
 * The mark's lower-right quadrant is deliberately empty (it is the piece that
 * was removed to form the "P"), and that is where the wordmark lives: a very
 * small "PNK" set in Poppins Black (OFL — see scripts/fonts/OFL.txt). The TTF
 * is parsed here and the glyphs are converted to outline paths, so the shipped
 * SVG needs no font, no <text> element and no raster fallback.
 *
 * Placement is computed, not eyeballed: the cap height is a fixed fraction of
 * the removed quadrant's radius (0.24 — enough for the letterforms to read),
 * and the text box is centred inside the feasible region between the two cut
 * lines (which run through the circle's centre) and the rim arc.
 */
export const WORDMARK_TEXT = "PNK";
export const WORDMARK_FONT = path.join(HERE, "fonts", "Poppins-Black.ttf");
/**
 * Cap height as a fraction of the removed quadrant's radius R. The text is
 * anchored at 75% across and 75% down the mark (the centre of the removed
 * quadrant), and 0.19 is the largest size whose ink still clears the rim arc
 * at that anchor (≈ 3.7 units of true clearance; 0.22 crosses the arc and
 * clips the K against the rim, 0.20 touches it exactly).
 */
export const WORDMARK_CAP_FRACTION = 0.19;
/** Wordmark fill per theme: deep navy on light grounds, near-white on dark. */
export const WORDMARK_COLORS = { light: "#1B2A6B", dark: "#E8EAED" };

/** TrueType tables the wordmark needs; anything fancier fails loudly. */
let FONT_CACHE = null;
function wordmarkFont() {
  if (FONT_CACHE) return FONT_CACHE;
  const buf = readFileSync(WORDMARK_FONT);
  const u16 = (o) => buf.readUInt16BE(o);
  const i16 = (o) => buf.readInt16BE(o);
  const u32 = (o) => buf.readUInt32BE(o);
  const magic = u32(0);
  if (magic !== 0x00010000 && magic !== 0x74727565) {
    throw new Error(`Poppins-Black.ttf is not TrueType (magic 0x${magic.toString(16)})`);
  }
  const tables = {};
  const numTables = u16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables[buf.toString("latin1", rec, rec + 4)] = u32(rec + 8);
  }
  for (const tag of ["cmap", "head", "hhea", "maxp", "hmtx", "loca", "glyf"]) {
    if (!tables[tag]) throw new Error(`font is missing the ${tag} table`);
  }

  // cmap: the Windows/Unicode BMP subtable (platform 3 encoding 1/10, or 0).
  const cmap = tables.cmap;
  const nSub = u16(cmap + 2);
  let sub = null;
  for (let i = 0; i < nSub; i++) {
    const rec = cmap + 4 + i * 8;
    const pid = u16(rec);
    const eid = u16(rec + 2);
    if ((pid === 3 && (eid === 1 || eid === 10)) || pid === 0) {
      sub = cmap + u32(rec + 4);
      break;
    }
  }
  if (sub === null) throw new Error("no Unicode cmap subtable");
  if (u16(sub) !== 4) throw new Error("cmap subtable is not format 4");
  const segX2 = u16(sub + 6);
  const segCount = segX2 >> 1;
  const endBase = sub + 14;
  const startBase = endBase + segX2 + 2;
  const deltaBase = startBase + segX2;
  const rangeBase = deltaBase + segX2;
  const glyphIndex = (cp) => {
    for (let s = 0; s < segCount; s++) {
      const end = u16(endBase + s * 2);
      const start = u16(startBase + s * 2);
      if (cp >= start && cp <= end) {
        if (start === 0xffff) return 0;
        const delta = i16(deltaBase + s * 2);
        const rangeOff = u16(rangeBase + s * 2);
        if (rangeOff === 0) return (cp + delta) & 0xffff;
        const gi = u16(rangeBase + s * 2 + rangeOff + (cp - start) * 2);
        return gi === 0 ? 0 : (gi + delta) & 0xffff;
      }
    }
    return 0;
  };

  const unitsPerEm = u16(tables.head + 18);
  if (unitsPerEm === 0) throw new Error("unitsPerEm is 0");
  const indexToLocFormat = i16(tables.head + 50);
  const numHMetrics = u16(tables.hhea + 34);
  const loca = tables.loca;
  const locaAt = (gi) => (indexToLocFormat === 0 ? u16(loca + gi * 2) * 2 : u32(loca + gi * 4));
  const advanceOf = (gi) => u16(tables.hmtx + Math.min(gi, numHMetrics - 1) * 4);

  /** One glyph's contours as arrays of [x, y, onCurve] points in font units. */
  const glyphContours = (gi) => {
    const start = locaAt(gi);
    const end = locaAt(gi + 1);
    if (end <= start) return [];
    const g = tables.glyf + start;
    const nContours = i16(g);
    if (nContours < 0) throw new Error("composite glyphs are not supported");
    let p = g + 10;
    const ends = [];
    for (let i = 0; i < nContours; i++) {
      ends.push(u16(p));
      p += 2;
    }
    const nPts = ends[ends.length - 1] + 1;
    p += 2 + u16(p); // skip the glyph's hinting instructions
    const flags = [];
    while (flags.length < nPts) {
      const f = buf[p++];
      flags.push(f);
      if (f & 8) {
        const rep = buf[p++];
        for (let r = 0; r < rep; r++) flags.push(f);
      }
    }
    const xs = [];
    for (let i = 0, x = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 2) {
        const d = buf[p++];
        x += f & 16 ? d : -d;
      } else if (!(f & 16)) {
        x += i16(p);
        p += 2;
      }
      xs.push(x);
    }
    const ys = [];
    for (let i = 0, y = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 4) {
        const d = buf[p++];
        y += f & 32 ? d : -d;
      } else if (!(f & 32)) {
        y += i16(p);
        p += 2;
      }
      ys.push(y);
    }
    const contours = [];
    let s = 0;
    for (const e of ends) {
      const pts = [];
      for (let i = s; i <= e; i++) pts.push([xs[i], ys[i], (flags[i] & 1) !== 0]);
      s = e + 1;
      contours.push(pts);
    }
    return contours;
  };

  FONT_CACHE = { glyphIndex, glyphContours, advanceOf, unitsPerEm };
  return FONT_CACHE;
}

const n2 = (v) => Number(v.toFixed(2));

/**
 * Typeset `text` at `capHeight` SVG units tall, with the layout origin — pen
 * start x = 0, baseline y = 0 (caps rise to y = -capHeight) — translated to
 * `origin`. Returns one path `d` (M/L/C/Z, one subpath per TrueType contour)
 * plus the laid-out ink bbox. Quadratic spline points are converted to exact
 * cubic Béziers (c1 = p0 + ⅔(c−p0), c2 = p1 + ⅔(c−p1)), so the outlines are
 * lossless and the shipped SVG carries the real Poppins Black shapes.
 */
export function typesetWordmark(text = WORDMARK_TEXT, capHeight = 30, origin = [0, 0]) {
  const font = wordmarkFont();
  const glyphs = [];
  for (const ch of text) {
    const gi = font.glyphIndex(ch.codePointAt(0));
    if (!gi) throw new Error(`font has no glyph for ${JSON.stringify(ch)}`);
    glyphs.push({ contours: font.glyphContours(gi), advance: font.advanceOf(gi) });
  }
  // Ink bbox in font units: for capitals its height IS the cap height, so the
  // scale is derived from it rather than trusting an OS/2 table.
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { contours } of glyphs) {
    for (const pts of contours) {
      for (const [, y] of pts) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!Number.isFinite(minY) || maxY <= minY) throw new Error("wordmark has no ink");
  const s = capHeight / (maxY - minY);
  const [ox, oy] = origin;
  // Walk the glyphs left to right, applying each glyph's advance width scaled
  // by s (advanceOf returns raw em units). Without this the glyphs all stack
  // at the pen origin on top of each other.
  const offsets = [];
  let pen = 0;
  for (const { advance } of glyphs) {
    offsets.push(pen);
    pen += advance * s;
  }
  let d = "";
  glyphs.forEach(({ contours }, gi) => {
    const oxg = ox + offsets[gi];
    const xy = ([x, y]) => [n2(x * s + oxg), n2(-y * s + oy)];
    for (const ptsRaw of contours) {
      if (ptsRaw.length < 2) continue;
      // Normalise so the ring starts on an on-curve point (or expand an
      // all-off-curve contour by inserting its implied midpoints).
      let ring;
      let start;
      if (ptsRaw.every((p) => !p[2])) {
        ring = ptsRaw.flatMap((p, i) => {
          const q = ptsRaw[(i + 1) % ptsRaw.length];
          return [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, true]];
        });
        start = xy(ring[ring.length - 1]);
      } else {
        const on = ptsRaw.findIndex((p) => p[2]);
        ring = [...ptsRaw.slice(on), ...ptsRaw.slice(0, on)];
        start = xy(ring[0]);
      }
      d += `M${start[0]},${start[1]}`;
      let prev = start;
      let ctrl = null;
      const lin = (to) => {
        d += `L${n2(to[0])},${n2(to[1])}`;
        prev = to;
      };
      const quad = (c, to) => {
        d +=
          `C${n2(prev[0] + ((c[0] - prev[0]) * 2) / 3)},${n2(prev[1] + ((c[1] - prev[1]) * 2) / 3)} ` +
          `${n2(to[0] + ((c[0] - to[0]) * 2) / 3)},${n2(to[1] + ((c[1] - to[1]) * 2) / 3)} ` +
          `${n2(to[0])},${n2(to[1])}`;
        prev = to;
      };
      for (let i = 1; i <= ring.length; i++) {
        const raw = ring[i % ring.length];
        const p = xy(raw);
        if (raw[2]) {
          if (ctrl) quad(ctrl, p);
          else lin(p);
          ctrl = null;
        } else if (ctrl) {
          // Second consecutive off-curve: TrueType inserts an implied on-curve
          // point midway between the two controls (not the last emitted point
          // — using `prev` here kinked every multi-off-curve spline, which is
          // exactly what broke the P's bowl shoulder).
          quad(ctrl, [(ctrl[0] + p[0]) / 2, (ctrl[1] + p[1]) / 2]);
          ctrl = p;
        } else {
          ctrl = p;
        }
      }
      if (ctrl) quad(ctrl, start);
      d += "Z";
    }
  });
  const pts = [];
  glyphs.forEach(({ contours }, gi) => {
    for (const c of contours) {
      for (const [x, y] of c) pts.push([x * s + ox + offsets[gi], -y * s + oy]);
    }
  });
  const bbox = polysBBox([pts]);
  return { d, bbox, capHeight, glyphs: glyphs.length };
}

/**
 * Compute the wordmark placement inside the removed lower-right quadrant of a
 * normalized (rebalanced) mark. The text box centre is pinned at 75% across
 * and 75% down the mark — CSS-style `75% 75%` — which is exactly the centre
 * of the removed quadrant. The cap fraction is chosen so the ink clears the
 * rim arc at that anchor (see WORDMARK_CAP_FRACTION); the fit guard throws if
 * a future size change would clip the rim or cross a cut line. Returns the
 * placed path plus the geometry the tests pin.
 */
export function placeWordmark(norm, capFraction = WORDMARK_CAP_FRACTION) {
  const art = norm.artwork;
  const OX = (art.minX + art.maxX) / 2;
  const OY = (art.minY + art.maxY) / 2;
  const W = art.maxX - art.minX;
  const H = art.maxY - art.minY;
  const R = W / 2; // the removed quadrant's radius
  const capHeight = r4(R * capFraction);
  const laid = typesetWordmark(WORDMARK_TEXT, capHeight, [0, 0]);
  const w = r4(laid.bbox.maxX - laid.bbox.minX);
  const h = r4(laid.bbox.maxY - laid.bbox.minY);
  // Anchor: 75% of the mark's width across, 75% of its height down.
  const cx = art.minX + 0.75 * W;
  const cy = art.minY + 0.75 * H;
  // Fit guards: the box's far corner stays inside the rim arc (with ≥ 1 unit
  // of slack) and both near edges clear their cut bands (half-width 5 + 1).
  if (Math.hypot(cx + w / 2 - OX, cy + h / 2 - OY) > R - 1) {
    throw new Error("wordmark does not fit between the cuts and the arc");
  }
  if (cx - w / 2 < OX + 6 || cy - h / 2 < OY + 6) {
    throw new Error("wordmark crosses a cut line");
  }
  // Baseline sits at the bottom of the caps box; centre the ink horizontally.
  const placed = typesetWordmark(
    WORDMARK_TEXT,
    capHeight,
    [r4(cx - (laid.bbox.minX + laid.bbox.maxX) / 2), r4(cy + h / 2)],
  );
  return {
    ...placed,
    OX: r4(OX),
    OY: r4(OY),
    R: r4(R),
    cx: r4(cx),
    cy: r4(cy),
    left: r4(cx - w / 2),
    right: r4(cx + w / 2),
    top: r4(cy - h / 2),
    bottom: r4(cy + h / 2),
  };
}

/**
 * Compose one theme variant of the shipped SVG: the normalized master with
 * the wordmark group appended. The mark's own shapes are untouched — the two
 * themes differ only in the wordmark's inline fill.
 */
export function composeVariant(norm, theme, placed = placeWordmark(norm)) {
  const color = WORDMARK_COLORS[theme];
  if (!color) throw new Error(`unknown theme variant: ${theme}`);
  const group = `<g id="wordmark-pnk" aria-label="PNK"><path fill="${color}" d="${placed.d}"/></g>`;
  const svg = norm.svg.replace(/<\/svg>\s*$/, `${group}</svg>\n`);
  if (svg === norm.svg) throw new Error("could not append the wordmark group");
  return { svg, color, placed };
}

/* ------------------------------------------------------------------ */
/* 3. Scanline rasterizer (stdlib-only PNG export)                     */
/* ------------------------------------------------------------------ */

function rectSpansOnRow(r, vy) {
  return vy >= r.y && vy < r.y + r.h ? [[r.x, r.x + r.w]] : [];
}

/** Even-odd scanline spans of a polygon set at row y. */
function polySpansOnRow(polys, vy) {
  const xs = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      if ((y1 <= vy && y2 > vy) || (y2 <= vy && y1 > vy)) {
        xs.push(x1 + ((vy - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
  }
  if (!xs.length) return [];
  xs.sort((a, b) => a - b);
  const spans = [];
  for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
  return spans;
}

function intersectSpanLists(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

function spansForPaint(parsed, paint, vy) {
  const shapeSpans =
    paint.shape.kind === "rect"
      ? rectSpansOnRow(paint.shape, vy)
      : polySpansOnRow(paint.shape.polys, vy);
  if (!shapeSpans.length) return shapeSpans;
  if (paint.clip) {
    return intersectSpanLists(shapeSpans, polySpansOnRow(parsed.clipPolys.get(paint.clip), vy));
  }
  return shapeSpans;
}

let CRC_TABLE = null;
function crc32(buf) {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA buffer -> PNG Buffer (color type 6, 8-bit, filter 0 rows). */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Rasterize a parsed SVG at `size` px (transparent background).
 * 4x supersampling with painter's-algorithm overwrite, then a box downsample
 * with un-premultiplied edges so the mark sits cleanly on any background.
 * @returns {Buffer} raw RGBA (size*size*4, top-down) — encoded by the callers
 */
export function renderRgba(parsed, size) {
  if (parsed.paints.length > 255) throw new Error("paint index exceeds Uint8 row buffer");
  const SS = 4;
  const S = size * SS;
  const [vx, vy0, vw] = parsed.viewBox;
  const u = vw / S; // viewBox units per supersample pixel
  const acc = new Float64Array(size * size * 4);
  const row = new Uint8Array(S); // paint index per supersample column (0 = clear)
  for (let j = 0; j < S; j++) {
    const vy = vy0 + (j + 0.5) * u;
    row.fill(0);
    for (let idx = 0; idx < parsed.paints.length; idx++) {
      const value = idx + 1;
      for (const [xa, xb] of spansForPaint(parsed, parsed.paints[idx], vy)) {
        const i0 = Math.max(0, Math.ceil((xa - vx) / u - 0.5));
        const i1 = Math.min(S - 1, Math.ceil((xb - vx) / u - 0.5) - 1);
        for (let i = i0; i <= i1; i++) row[i] = value;
      }
    }
    for (let i = 0; i < S; i++) {
      const v = row[i];
      if (!v) continue;
      const [r, g, b] = parsed.paints[v - 1].rgb;
      const o = (((j / SS) | 0) * size + ((i / SS) | 0)) * 4;
      acc[o] += r;
      acc[o + 1] += g;
      acc[o + 2] += b;
      acc[o + 3] += 255;
    }
  }
  const rgba = Buffer.alloc(size * size * 4);
  const per = SS * SS;
  for (let p = 0; p < size * size; p++) {
    const o = p * 4;
    rgba[o + 3] = Math.round(acc[o + 3] / per);
    if (acc[o + 3] > 0) {
      // Un-premultiply so edges stay clean over any background.
      rgba[o] = Math.round((acc[o] / acc[o + 3]) * 255);
      rgba[o + 1] = Math.round((acc[o + 1] / acc[o + 3]) * 255);
      rgba[o + 2] = Math.round((acc[o + 2] / acc[o + 3]) * 255);
    }
  }
  return rgba;
}

/** RGBA raster of the mark at `size` px -> PNG bytes. */
export function renderPng(parsed, size) {
  return encodePng(size, size, renderRgba(parsed, size));
}

/* ------------------------------------------------------------------ */
/* 3b. Windows icon (.ico)                                             */
/* ------------------------------------------------------------------ */

/**
 * Icon sizes Windows actually asks for, largest entry first: 16 in list views,
 * 24/32 in the taskbar and small tiles, 48/64 in medium tiles, 128/256 for
 * large tiles and Extra Large Icons.
 */
export const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];

/**
 * One 32-bpp icon bitmap: BITMAPINFOHEADER + bottom-up BGRA rows + AND mask.
 * Transparency is carried by the alpha channel, so the 1-bpp AND mask stays
 * all-zero (fully opaque), which is exactly what Windows expects at 32 bpp.
 */
export function encodeDib(size, rgba) {
  const HEADER = 40;
  const xorBytes = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4; // 1 bpp rows, padded to 4 bytes
  const out = Buffer.alloc(HEADER + xorBytes + maskStride * size);
  out.writeUInt32LE(HEADER, 0); // biSize
  out.writeInt32LE(size, 4); // biWidth
  out.writeInt32LE(size * 2, 8); // biHeight = XOR image + AND mask
  out.writeUInt16LE(1, 12); // biPlanes
  out.writeUInt16LE(32, 14); // biBitCount
  out.writeUInt32LE(0, 16); // biCompression = BI_RGB
  out.writeUInt32LE(xorBytes, 20); // biSizeImage
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // DIB rows run bottom-up
    const dst = HEADER + y * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = dst + x * 4;
      out[d] = rgba[s + 2]; // B
      out[d + 1] = rgba[s + 1]; // G
      out[d + 2] = rgba[s]; // R
      out[d + 3] = rgba[s + 3]; // A
    }
  }
  return out; // the AND mask is already zeroed
}

/**
 * Multi-resolution .ico of the mark, largest entry first. 256 and 128 are PNG
 * (the convention for large icon entries); the rest are classic 32-bpp DIBs,
 * which the in-box C# compiler's /win32icon and every shell path read.
 */
export function renderIco(parsed) {
  const images = ICO_SIZES.map((size) => {
    const rgba = renderRgba(parsed, size);
    const data = size >= 128 ? encodePng(size, size, rgba) : encodeDib(size, rgba);
    return { size, data };
  });
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4); // image count
  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir[e] = img.size >= 256 ? 0 : img.size; // 0 means 256
    dir[e + 1] = img.size >= 256 ? 0 : img.size;
    dir[e + 2] = 0; // palette entries
    dir[e + 3] = 0; // reserved
    dir.writeUInt16LE(1, e + 4); // colour planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([dir, ...images.map((img) => img.data)]);
}

/* ------------------------------------------------------------------ */
/* 4. Preview page                                                     */
/* ------------------------------------------------------------------ */

function renderPreviewHtml(variants, pngs, parsedLight, parsedDark) {
  const svgUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  const pngUri = (name) => `data:image/png;base64,${pngs.get(name).toString("base64")}`;
  const swatches = (parsed) =>
    [...new Set(parsed.paints.map((p) => p.hex))]
      .map((hex) => `<span class="sw"><span class="chip" style="background:${hex}"></span>${hex}</span>`)
      .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PNK Suguan System — Logo</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:32px; font:14px/1.5 system-ui, sans-serif; background:#14161a; color:#e8eaed; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { margin:0 0 24px; color:#9aa0a6; }
  h2 { font-size:14px; margin:28px 0 12px; color:#9aa0a6; }
  .row { display:flex; flex-wrap:wrap; gap:24px; align-items:flex-end; margin-bottom:24px; }
  .card { border-radius:12px; padding:16px; text-align:center; }
  .card.on-light { background:#f4f5f7; border:1px solid #d8dbe0; }
  .card.on-dark { background:#10141d; border:1px solid #2a2d33; }
  .card img { display:block; }
  .cap { margin-top:10px; color:#9aa0a6; font-size:12px; }
  .checker { background: repeating-conic-gradient(#2a2d33 0% 25%, #17191d 0% 50%) 0 0 / 20px 20px; }
  .sw { display:inline-flex; align-items:center; gap:8px; background:#1e2126; border:1px solid #2a2d33; border-radius:8px; padding:6px 10px; font-size:12px; }
  .chip { width:16px; height:16px; border-radius:4px; border:1px solid rgba(255,255,255,.15); display:inline-block; }
  code { color:#c7cbd1; }
</style>
</head>
<body>
<h1>PNK Suguan System — logo</h1>
<p class="sub">Master: <code>scripts/logo-master.svg</code> &rarr; <code>npm run logo</code> regenerates everything on this page.</p>
<h2>Light theme &mdash; pnk-suguan-logo.svg (wordmark #1B2A6B)</h2>
<div class="row">
  <div class="card on-light"><img src="${svgUri(variants.light)}" width="288" height="288" alt="light theme SVG master"><div class="cap">SVG master</div></div>
  <div class="card on-light"><img src="${pngUri("pnk-suguan-logo-512.png")}" width="288" height="288" alt="light 512 px PNG"><div class="cap">512 px</div></div>
  <div class="card on-light"><img src="${pngUri("pnk-suguan-logo-256.png")}" width="128" height="128" alt="light 256 px PNG"><div class="cap">256 px</div></div>
  <div class="card on-light"><img src="${pngUri("pnk-suguan-logo-64.png")}" width="64" height="64" alt="light 64 px PNG"><div class="cap">64 px</div></div>
</div>
<h2>Dark theme &mdash; pnk-suguan-logo-dark.svg (wordmark #E8EAED)</h2>
<div class="row">
  <div class="card on-dark"><img src="${svgUri(variants.dark)}" width="288" height="288" alt="dark theme SVG master"><div class="cap">SVG master</div></div>
  <div class="card on-dark"><img src="${pngUri("pnk-suguan-logo-dark-512.png")}" width="288" height="288" alt="dark 512 px PNG"><div class="cap">512 px</div></div>
  <div class="card on-dark"><img src="${pngUri("pnk-suguan-logo-dark-256.png")}" width="128" height="128" alt="dark 256 px PNG"><div class="cap">256 px</div></div>
  <div class="card on-dark"><img src="${pngUri("pnk-suguan-logo-dark-64.png")}" width="64" height="64" alt="dark 64 px PNG"><div class="cap">64 px</div></div>
</div>
<div class="row">
  <div class="card checker"><img src="${pngUri("pnk-suguan-logo-512.png")}" width="192" height="192" alt="light transparency check"><div class="cap">light &mdash; transparent ground</div></div>
  <div class="card checker"><img src="${pngUri("pnk-suguan-logo-dark-512.png")}" width="192" height="192" alt="dark transparency check"><div class="cap">dark &mdash; transparent ground</div></div>
</div>
<div class="row">
  <div>${swatches(parsedLight)}${swatches(parsedDark)}</div>
</div>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* 5. Output — scratch only; the shipped artwork is never written      */
/* ------------------------------------------------------------------ */

/**
 * Render every asset into memory (filename -> Buffer). Nothing touches the
 * disk, so --check can compare against the shipped files without rendering
 * twice and without any risk of overwriting them.
 */
export function buildAssets() {
  const master = readFileSync(MASTER_PATH, "utf8");
  const norm = normalizeViewBox(master);
  const wordmark = placeWordmark(norm);
  const variants = {};
  const parsed = {};
  const pngs = new Map(); // name -> Buffer, for the preview page
  const files = new Map();
  for (const theme of Object.keys(WORDMARK_COLORS)) {
    const v = composeVariant(norm, theme, wordmark);
    variants[theme] = v.svg;
    parsed[theme] = parseSvg(v.svg);
    const stem = theme === "light" ? "pnk-suguan-logo" : "pnk-suguan-logo-dark";
    files.set(`${stem}.svg`, Buffer.from(v.svg, "utf8"));
    for (const s of SIZES) {
      const buf = renderPng(parsed[theme], s);
      pngs.set(`${stem}-${s}.png`, buf);
      files.set(`${stem}-${s}.png`, buf);
    }
  }
  // The .ico is embedded by the Windows installer and pointed at by the
  // shortcuts; it ships the light variant, matching the default light theme.
  files.set("pnk-suguan.ico", renderIco(parsed.light));
  files.set("preview.html", Buffer.from(renderPreviewHtml(variants, pngs, parsed.light, parsed.dark), "utf8"));
  // The SHIPPED subset: preview.html is scratch-only, never published.
  const shipped = new Map([...files].filter(([name]) => name !== "preview.html"));
  return { files, shipped, norm, variants, parsed, wordmark };
}

/**
 * Refuse to write anywhere inside the shipped artwork directory. This is the
 * code half of the .gitignore note — the guard is what makes it impossible for
 * a test run or a stray `npm run logo` to overwrite the supplied logo again.
 */
export function assertNotPublicDir(outDir) {
  const rel = path.relative(PUBLIC_DIR, path.resolve(outDir));
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (inside) {
    throw new Error(
      `refusing to write into ${path.relative(ROOT, PUBLIC_DIR)} — that artwork is hand-supplied and shipped. ` +
        `Render into ${path.relative(ROOT, SCRATCH_DIR)}/ instead, then copy files across deliberately.`,
    );
  }
}

/** Render every asset into `outDir` (scratch by default). Returns the paths written. */
export function writeAssets(outDir = SCRATCH_DIR) {
  assertNotPublicDir(outDir);
  mkdirSync(outDir, { recursive: true });
  const { files } = buildAssets();
  const written = [];
  for (const [name, buf] of files) {
    const p = path.join(outDir, name);
    writeFileSync(p, buf);
    written.push(p);
  }
  return written;
}

/** Compare a fresh render against a directory (the shipped artwork by default) without writing anything. */
export function checkAssets(dir = PUBLIC_DIR) {
  const { files, shipped } = buildAssets();
  const drift = [];
  const missing = [];
  for (const [name, buf] of shipped) {
    let onDisk;
    try {
      onDisk = readFileSync(path.join(dir, name));
    } catch {
      missing.push(name);
      continue;
    }
    if (!onDisk.equals(buf)) drift.push(name);
  }
  return { ok: drift.length === 0 && missing.length === 0, drift, missing, files, shipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--check")) {
    const { ok, drift, missing } = checkAssets();
    if (ok) {
      console.log(`  \u2713 ${path.relative(ROOT, PUBLIC_DIR)} matches a fresh render`);
    } else {
      for (const n of missing) console.error(`  ! missing ${path.relative(ROOT, PUBLIC_DIR)}/${n}`);
      for (const n of drift) console.error(`  ! ${path.relative(ROOT, PUBLIC_DIR)}/${n} differs from a fresh render`);
      console.error("  \u2192 update scripts/logo-master.svg, or copy the matching file out of logo-render/ on purpose.");
      process.exit(1);
    }
  } else {
    for (const f of writeAssets(SCRATCH_DIR)) console.log(`  \u2713 wrote ${path.relative(ROOT, f)}`);
    console.log(
      `  i ${path.relative(ROOT, PUBLIC_DIR)}/ was NOT touched (guarded) — copy files there deliberately when the master changes.`,
    );
  }
}
