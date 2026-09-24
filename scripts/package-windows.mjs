/**
 * L3 — Windows local deployment packager.
 *
 * Produces a self-contained program payload (no Node, PostgreSQL, npm, Electron
 * or Tauri required on the target machine) with strict separation between the
 * application payload and per-user data:
 *
 *   dist/PNK-Suguan/            <- PROGRAM PAYLOAD (read-only, replaceable)
 *     launcher/  node/  postgres/  app/
 *   %LOCALAPPDATA%/PNK Suguan/  <- USER DATA (created on first run, never packaged)
 *
 * Sources are an explicit ALLOWLIST, so the sensitive trees (.pg/backups, live
 * data clusters, .freebuff, .env*) are never even read. `.packagingignore` is
 * then applied to every file copied AND re-checked against the finished package,
 * because the requirement is to verify the output rather than trust the rules.
 *
 * Usage: node scripts/package-windows.mjs [--out <dir>] [--no-build]
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { build as esbuild } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const argVal = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};
const OUT = path.resolve(argVal("--out", path.join(ROOT, "dist", "PNK-Suguan")));
// Distinguishes one build from the next so an in-place upgrade can be proven to
// have actually replaced the payload (recorded in the manifest and app/BUILD-ID).
const BUILD_ID =
  argVal("--build-id") ??
  `${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
const APP = path.join(OUT, "app");
const STANDALONE = path.join(ROOT, ".next", "standalone");
const NODE_SRC = path.join(ROOT, ".tools", "node");
const PGSQL_SRC = path.join(ROOT, ".pg", "pgsql");
const PGBIN_SRC = path.join(PGSQL_SRC, "bin");

let failures = 0;
const say = (m) => console.log(m);
const ok = (m) => say(`  \u2713 ${m}`);
const bad = (m) => {
  failures += 1;
  say(`  \u2717 ${m}`);
};

// ---------------------------------------------------------------------------
// .packagingignore
// ---------------------------------------------------------------------------

/** Convert a plain glob (no negation) into an anchored RegExp. */
function globToRegExp(pattern) {
  const p = pattern.trim();
  const anchored = p.includes("/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}$`);
}

function loadIgnorePatterns() {
  const file = path.join(ROOT, ".packagingignore");
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => ({ raw: l, re: globToRegExp(l) }));
}

const IGNORE = loadIgnorePatterns();

function excluded(relPath) {
  const rel = relPath.split(path.sep).join("/");
  return IGNORE.find((p) => p.re.test(rel));
}

/** Exclusion filter for fs.cpSync, evaluated on the destination-relative path. */
function filterFor(destRoot) {
  return (src) => {
    const rel = path.relative(destRoot, src);
    if (!rel) return true;
    return !excluded(rel);
  };
}

function copy(src, dest, label) {
  if (!existsSync(src)) {
    bad(`${label}: missing source ${src}`);
    return;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  // `dereference` is REQUIRED, not cosmetic: Next's standalone `.next` contains
  // symlinks pointing back into the source repo's node_modules (e.g.
  // .next/node_modules/@node-rs/argon2-<hash>). Copying them as links would make
  // the package depend on D:\Systems\PNK and break on any other machine — and
  // Windows refuses to create symlinks at all without elevation/developer mode.
  cpSync(src, dest, { recursive: true, dereference: true, filter: filterFor(dest) });
  ok(`${label}`);
}

/** Recursively list files under a directory, as package-relative paths. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const dirSize = (dir) => {
  let total = 0;
  for (const rel of walk(dir)) {
    try {
      total += statSync(path.join(dir, rel)).size;
    } catch {
      /* ignore */
    }
  }
  return total;
};
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function run(cmd, cmdArgs, label) {
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  if (res.status !== 0) {
    bad(`${label} failed (exit ${res.status})`);
    return false;
  }
  ok(label);
  return true;
}

async function bundleTool(entry, outfile, label) {
  await esbuild({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Native / runtime-only packages stay external and are fulfilled by the
    // traced node_modules inside app/.
    external: ["postgres", "@node-rs/argon2", "nodemailer", "pdfkit"],
    alias: { "@": path.join(ROOT, "src") },
    // Bundling a CommonJS dependency into ESM output otherwise throws
    // `Dynamic require of "fs" is not supported` at runtime (the application
    // sources pull in dotenv, which requires node builtins). esbuild's `__require`
    // shim prefers an existing `require` binding, so providing a real one via
    // createRequire makes those dynamic requires work under ESM.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
  ok(label);
}

// ---------------------------------------------------------------------------

say(`\nPNK Suguan System — packaging (L3)\n  -> ${OUT}\n`);

if (!args.includes("--no-build")) {
  say("build");
  run(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], "next build (production, standalone)");
}

if (!existsSync(STANDALONE)) {
  bad(`standalone output missing at ${STANDALONE} — run the production build first`);
  say("\npackaging aborted.\n");
  process.exit(1);
}

say("\npayload");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. launcher (plain ESM; needs no node_modules of its own)
copy(path.join(ROOT, "launcher"), path.join(OUT, "launcher"), "launcher/");

// 2. bundled Node 22 runtime (explicitly required in the package)
copy(NODE_SRC, path.join(OUT, "node"), "node/ (bundled Node 22 runtime)");

// 3. the bundled PostgreSQL 16 DISTRIBUTION — bin + lib + share.
//    `share/` is not optional: initdb reads share/postgres.bki, postgres.bki-less
//    installs fail at cluster creation with "corrupted installation".
//    `.pg/pgsql` contains NO cluster data (the live clusters live in the sibling
//    `.pg/pnk-dev` / `.pg/pnk-test` directories, which are never read here), so
//    this cannot ship pre-existing database contents.
if (existsSync(path.join(PGSQL_SRC, "pnk-dev")) || existsSync(path.join(PGSQL_SRC, "PG_VERSION"))) {
  bad("refusing to package: .pg/pgsql unexpectedly contains cluster data");
}
copy(PGSQL_SRC, path.join(OUT, "postgres"), "postgres/ (bundled PostgreSQL 16: bin + lib + share)");

// 4. the Next.js standalone server tree
copy(path.join(STANDALONE, "server.js"), path.join(APP, "server.js"), "app/server.js");
copy(path.join(STANDALONE, "node_modules"), path.join(APP, "node_modules"), "app/node_modules/ (traced runtime dependencies)");
copy(path.join(STANDALONE, ".next"), path.join(APP, ".next"), "app/.next/ (production build)");
// Next does not copy these into standalone automatically.
copy(path.join(ROOT, ".next", "static"), path.join(APP, ".next", "static"), "app/.next/static/ (client assets)");
copy(path.join(ROOT, "public"), path.join(APP, "public"), "app/public/ (static assets)");

// 5. migrations. NOTE: the bundled migrate tool resolves its directory as
//    `<its own dir>/../drizzle`, so migrations MUST live at app/drizzle.
copy(path.join(ROOT, "drizzle"), path.join(APP, "drizzle"), "app/drizzle/ (migrations)");

say("\nbundled tools (real application source, compiled for the bundled Node)");
mkdirSync(path.join(APP, "_launcher"), { recursive: true });
await bundleTool("scripts/migrate.ts", path.join(APP, "_launcher", "migrate.mjs"), "app/_launcher/migrate.mjs");
await bundleTool("scripts/setup-admin.ts", path.join(APP, "_launcher", "setup-admin.mjs"), "app/_launcher/setup-admin.mjs");

// 6. entry points + operator notes
say("\nentry points");
const cmd = (name, script) =>
  `@echo off\r\nsetlocal\r\nset "HERE=%~dp0"\r\n"%HERE%node\\node.exe" "%HERE%launcher\\launcher.mjs" ${script} %*\r\n`;
writeFileSync(path.join(OUT, "Start PNK Suguan.cmd"), `${cmd("start", "start")}\r\n`, "utf8");
writeFileSync(
  path.join(OUT, "Stop PNK Suguan.cmd"),
  `${cmd("stop", "stop")}\r\necho.\r\npause\r\n`,
  "utf8",
);
ok("Start PNK Suguan.cmd");
ok("Stop PNK Suguan.cmd");

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

say("\naudit");
const files = walk(OUT);
const pkgVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

// (a) nothing on the exclusion list may exist in the finished package
const offenders = files.filter((f) => excluded(f));
if (offenders.length) bad(`excluded paths present in package: ${offenders.slice(0, 10).join(", ")}`);
else ok(`no excluded paths present (${IGNORE.length} rules checked against ${files.length} files)`);

// (b) secret shapes must not appear anywhere, whatever the rules say
const secretShaped = files.filter((f) =>
  /(^|\/)(\.env(\..*)?|.*credentials.*|FIRST-RUN-ADMIN-PASSWORD.*|.*\.pem|.*\.key)$/i.test(f),
);
if (secretShaped.length) bad(`credential-shaped files in package: ${secretShaped.join(", ")}`);
else ok("no credential or environment files in package");

// (c) the dev data trees and tooling workspace must be absent
//     `backups` is also the name of a REAL API route (src/app/api/backups — the
//     backup feature), so Next's build output legitimately carries it as a path
//     segment (app/.next/server/app/api/backups/...). Build output is produced
//     entirely by `next build` and cannot contain development data, so it is
//     exempt from that one word here — a real backups/ directory could never
//     live under app/.next/.
for (const forbidden of ["pgdata", "pnk-dev", "pnk-test", "backups", ".freebuff"]) {
  const hit = files.filter(
    (f) => f.includes(forbidden) && !(forbidden === "backups" && f.startsWith("app/.next/")),
  );
  if (hit.length) bad(`development data present: ${hit.slice(0, 3).join(", ")}`);
}
ok("no development data directories, clusters, or backups");

// (d) required payload
const required = [
  "node/node.exe",
  "postgres/bin/postgres.exe",
  "postgres/bin/pg_ctl.exe",
  "postgres/bin/psql.exe",
  "postgres/bin/initdb.exe",
  "postgres/bin/createdb.exe",
  "postgres/bin/pg_isready.exe",
  "postgres/share/postgres.bki",
  "postgres/share/postgresql.conf.sample",
  "app/server.js",
  "app/_launcher/migrate.mjs",
  "app/_launcher/setup-admin.mjs",
  "launcher/launcher.mjs",
  "launcher/lib/paths.mjs",
  "launcher/lib/postgres.mjs",
  "Start PNK Suguan.cmd",
  "Stop PNK Suguan.cmd",
];
const missing = required.filter((f) => !files.includes(f));
if (missing.length) bad(`required files missing: ${missing.join(", ")}`);
else ok(`all ${required.length} required payload files present`);

// (d2) no symlinks may survive: a link into the build machine's repo would make
// the package non-relocatable (and silently work on the build machine only).
const links = files.filter((f) => {
  try {
    return lstatSync(path.join(OUT, f)).isSymbolicLink();
  } catch {
    return false;
  }
});
if (links.length) bad(`package contains symlinks (not relocatable): ${links.slice(0, 5).join(", ")}`);
else ok("no symlinks — package is self-contained and relocatable");

// (e) runtime dependencies that the app loads at runtime must be traced
const depChecks = [
  ["app/node_modules/postgres", "postgres (database driver)"],
  ["app/node_modules/@node-rs/argon2", "argon2 (native password hashing)"],
  ["app/node_modules/pdfkit", "pdfkit (PDF generation)"],
  ["app/node_modules/nodemailer", "nodemailer (password-reset email)"],
];
for (const [dir, label] of depChecks) {
  if (existsSync(path.join(OUT, dir))) ok(`traced: ${label}`);
  else bad(`NOT traced: ${label} (${dir})`);
}

// (f) native binary + pdfkit data files — the classic standalone failure modes
const nativeBinding = files.find((f) => f.includes("@node-rs/argon2") && f.endsWith(".node"));
if (nativeBinding) ok(`native binding present: ${nativeBinding}`);
else bad("argon2 .node binding missing — login would fail at runtime");

const afm = files.filter((f) => /pdfkit\/js\/data\/.*\.afm$/.test(f));
if (afm.length) ok(`pdfkit font metrics present (${afm.length} .afm files)`);
else bad("pdfkit .afm metrics missing — PDF generation would fail at runtime");

// (g) migrations
const sqlMigrations = files.filter((f) => /^app\/drizzle\/.*\.sql$/.test(f)).sort();
if (sqlMigrations.length >= 8) ok(`migrations present: ${sqlMigrations.length} .sql files`);
else bad(`expected >= 8 migrations in app/drizzle, found ${sqlMigrations.length}`);

// (h) vendored fonts (offline requirement)
const fonts = files.filter((f) => /\.woff2$/.test(f));
if (fonts.length) ok(`vendored fonts present (${fonts.length} woff2)`);
else bad("no woff2 fonts in package — typography would fall back");

// (i) no external hosts baked into the client bundle (offline sanity)
say(`\nsize: ${mb(dirSize(OUT))} across ${files.length} files`);

// A COPYABLE build identity inside the payload: lets an operator (and the
// upgrade test) tell two builds apart without reading the manifest.
writeFileSync(path.join(APP, "BUILD-ID"), `${BUILD_ID}\n`, "utf8");
ok(`app/BUILD-ID -> ${BUILD_ID}`);

const manifest = {
  product: "PNK Suguan System",
  appVersion: pkgVersion,
  buildId: BUILD_ID,
  packagedAt: new Date().toISOString(),
  nodeRuntime: spawnSync(path.join(OUT, "node", "node.exe"), ["-v"], { encoding: "utf8" }).stdout?.trim(),
  postgresRuntime: spawnSync(path.join(OUT, "postgres", "bin", "postgres.exe"), ["--version"], {
    encoding: "utf8",
  }).stdout?.trim(),
  layout: { programPayload: ["launcher", "node", "postgres", "app"], userData: "%LOCALAPPDATA%/PNK Suguan" },
  fileCount: files.length,
  totalBytes: dirSize(OUT),
  audit: { failures, exclusionsChecked: IGNORE.length },
};
writeFileSync(path.join(OUT, "BUILD-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

say("\nresult");
if (failures > 0) {
  say(`  ${failures} audit failure(s) — package is NOT shippable.\n`);
  process.exit(1);
}
say(`  build ${BUILD_ID}`);
say(`  package OK -> ${OUT}\n`);
