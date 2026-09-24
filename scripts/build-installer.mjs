#!/usr/bin/env node
/**
 * L6 - build the Windows installer (PNK Suguan System).
 *
 * Deployment layer only: this script zips the *already validated* program
 * payload from dist/PNK-Suguan, audits the zip for forbidden content, and
 * compiles the installer with the in-box .NET Framework C# compiler. It does
 * not build the application, change the launcher, or own any runtime
 * responsibility.
 *
 * Usage:  .tools/node/node.exe scripts/build-installer.mjs [--out-dir dist] [--payload-dir dist/PNK-Suguan]
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT_DIR = argValue("--out-dir") ?? "dist";
const PAYLOAD_DIR = path.resolve(
  argValue("--payload-dir") ?? path.join(ROOT, OUT_DIR, "PNK-Suguan"),
);
const BUILD_DIR = path.join(ROOT, ".freebuff", "l6", "build");
const SOURCE = path.join(ROOT, "installer", "PnkSuguanSetup.cs");
/**
 * Shipped brand icon: it gives the setup EXE (and its copy, the uninstaller that
 * the Apps & Features entry points at) a real icon, and the payload copy is what
 * the shortcuts' IconLocation targets. Produced by `npm run logo`.
 */
const ICON = path.join(ROOT, "public", "logo", "pnk-suguan.ico");
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const FW = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319";

/**
 * Credential/development artifacts that must never ship. These are matched as
 * *file names*, never as generic keywords: the payload legitimately contains
 * application code such as change-password routes and library files named
 * cookies.js, and a keyword scan would flag all of them.
 */
const FORBIDDEN = [
  ["environment file", /(^|\/)\.env($|\.\/|\/)/],
  ["first-run password notice", /first-run-admin-password/i],
  ["qa admin credentials", /super-admin-credentials/i],
  ["qa session cookies", /super-cookies/i],
  ["qa credential dump", /credentials?\.(txt|json)$/i],
  ["freebuff scaffold", /(^|\/)\.freebuff(\/|$)/i],
  ["development database", /pnk-(dev|test)/i],
  // `backups` is also a REAL API route's path segment inside Next's build
  // output (app/.next/server/app/api/backups/...), so that tree is exempt —
  // `next build` output cannot contain development data, and a real backups/
  // directory could never live under app/.next/.
  ["packaged database backups", /(^|\/)backups(\/|$)/],
  ["postgres data directory", /(^|\/)pgdata(\/|$)/],
  ["repository .pg tree", /(^|\/)\.pg(\/|$)/],
  ["git metadata", /(^|\/)\.git(\/|$)/],
  ["next dev/cache output", /\.next\/(dev|cache)(\/|$)/],
  ["build info leftovers", /(tsbuildinfo|next-dev\.log)$/i],
];

/**
 * The payload must carry these, or the installation cannot start. Every anchor
 * was confirmed against the L5-validated package.
 */
const REQUIRED = [
  ["bundled node runtime", /^(\.\/)?node\/node\.exe$/],
  ["bundled initdb", /^(\.\/)?postgres\/bin\/initdb\.exe$/],
  ["bundled pg_ctl", /^(\.\/)?postgres\/bin\/pg_ctl\.exe$/],
  ["bundled postgres", /^(\.\/)?postgres\/bin\/postgres\.exe$/],
  ["bundled pg_dump", /^(\.\/)?postgres\/bin\/pg_dump\.exe$/],
  ["standalone next server", /^(\.\/)?app\/server\.js$/],
  ["argon2 native binding", /argon2\.win32-x64-msvc\.node$/],
  ["pdfkit afm metrics", /pdfkit[^/]*\/js\/data\/Helvetica\.afm$/],
  ["nodemailer", /nodemailer/i],
  ["migration 0000", /app\/drizzle\/0000_[^/]*\.sql$/],
  ["vendored font (inter)", /\.next\/static\/media\/inter[^/]*\.woff2$/],
  ["vendored font (manrope)", /\.next\/static\/media\/manrope[^/]*\.woff2$/],
  ["launcher", /^(\.\/)?launcher\/launcher\.mjs$/],
  ["brand icon (shortcuts point at it)", /app\/public\/logo\/pnk-suguan\.ico$/],
  ["build manifest", /^(\.\/)?BUILD-MANIFEST\.json$/],
];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function say(msg = "") {
  console.log(msg);
}
function ok(msg) {
  console.log(`  ok   ${msg}`);
}
function fail(msg) {
  console.error(`  FAIL ${msg}`);
  process.exitCode = 1;
}
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...opts });
  if (res.error) throw new Error(`${path.basename(cmd)} failed: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(
      `${path.basename(cmd)} exited ${res.status}\n${res.stdout ?? ""}\n${res.stderr ?? ""}`,
    );
  }
  return res.stdout ?? "";
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// --------------------------------------------------------------------- preflight
say("PNK Suguan System - installer build (L6)");
say("");

if (!existsSync(PAYLOAD_DIR)) {
  fail(`program payload not found: ${PAYLOAD_DIR}`);
  fail("run scripts/package-windows.mjs first");
  process.exit(1);
}
if (!existsSync(SOURCE)) {
  fail(`installer source not found: ${SOURCE}`);
  process.exit(1);
}
if (!existsSync(CSC)) {
  fail(`C# compiler not found: ${CSC}`);
  process.exit(1);
}
if (!existsSync(ICON)) {
  fail(`brand icon not found: ${path.relative(ROOT, ICON)}`);
  fail("regenerate it with `npm run logo` and copy it into public/logo/");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(PAYLOAD_DIR, "BUILD-MANIFEST.json"), "utf8"));
const version = readFileSync(SOURCE, "utf8").match(/APP_VERSION = "([^"]+)"/)?.[1];
if (!version) {
  fail("could not read APP_VERSION from the installer source");
  process.exit(1);
}
say(`  payload  ${manifest.fileCount} files, ${mb(manifest.totalBytes)}`);
say(`  buildId  ${manifest.buildId}`);
say(`  version  ${version}`);
say(`  icon     ${path.relative(ROOT, ICON)}`);
say(`  output   ${path.join(OUT_DIR, `PNK-Suguan-Setup-${version}.exe`)}`);
say("");

// ----------------------------------------------------------------- payload zip
rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(BUILD_DIR, { recursive: true });
const payloadZip = path.join(BUILD_DIR, "payload.zip");

say("== payload archive ==");
const tar = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, "System32", "tar.exe")
  : "tar.exe";
run(tar, ["-a", "-c", "-f", payloadZip, "-C", PAYLOAD_DIR, "."]);
const zipBytes = statSync(payloadZip).size;
ok(`payload.zip ${mb(zipBytes)} (${manifest.totalBytes} raw -> ${((zipBytes / manifest.totalBytes) * 100).toFixed(1)}%)`);

// ------------------------------------------------------------- payload audit
say("");
say("== payload audit ==");
const entries = run(tar, ["-tf", payloadZip])
  .split(/\r?\n/)
  .filter(Boolean)
  .map((e) => e.replace(/\\/g, "/"));

let auditFailures = 0;
for (const [label, re] of FORBIDDEN) {
  const hits = entries.filter((e) => {
    if (!re.test(e)) return false;
    // app/.next/ is Next's build output (see the FORBIDDEN note) — exempt from
    // the backups rule only, since that word is also the API route's own name.
    // tar entries arrive as "./app/...", so normalize before testing the prefix.
    const rel = e.replace(/^\.\//, "");
    return !(label === "packaged database backups" && rel.startsWith("app/.next/"));
  });
  if (hits.length) {
    auditFailures += 1;
    fail(`${label}: ${hits.length} entr(y|ies), e.g. ${hits.slice(0, 3).join(", ")}`);
  }
}
if (auditFailures === 0) ok(`no forbidden content in ${entries.length} entries`);

for (const [label, re] of REQUIRED) {
  if (entries.some((e) => re.test(e))) ok(`present: ${label}`);
  else {
    auditFailures += 1;
    fail(`missing: ${label}`);
  }
}

// symlink check: bsdtar lists links as "name -> target"
const verbose = run(tar, ["-tvf", payloadZip]).split(/\r?\n/);
const links = verbose.filter((l) => l.includes(" -> ") || /^l/.test(l));
if (links.length) {
  auditFailures += 1;
  fail(`symlinks in payload: ${links.length}`);
} else {
  ok("no symlinks");
}
if (entries.length !== manifest.fileCount + 1 && entries.length !== manifest.fileCount) {
  say(`  note archive holds ${entries.length} entries for ${manifest.fileCount} manifest files (directory entries included)`);
}
if (auditFailures) {
  fail("payload audit failed - not compiling the installer");
  process.exit(1);
}

// ------------------------------------------------------------------- compile
say("");
say("== compile installer ==");
const outExe = path.join(ROOT, OUT_DIR, `PNK-Suguan-Setup-${version}.exe`);
run(CSC, [
  "/nologo",
  "/target:exe",
  "/platform:x64",
  "/optimize+",
  "/codepage:65001",
  `/win32icon:${ICON}`,
  `/out:${outExe}`,
  `/r:${path.join(FW, "System.IO.Compression.dll")}`,
  `/r:${path.join(FW, "System.IO.Compression.FileSystem.dll")}`,
  `/resource:${payloadZip},payload.zip`,
  SOURCE,
]);
ok(`compiled ${path.basename(outExe)}`);

// -------------------------------------------------------------------- report
const exeBytes = statSync(outExe).size;
const sidecar = {
  product: "PNK Suguan System",
  installerVersion: version,
  payloadAppVersion: manifest.appVersion,
  payloadBuildId: manifest.buildId,
  payloadFileCount: manifest.fileCount,
  payloadBytes: manifest.totalBytes,
  installerBytes: exeBytes,
  installerSha256: sha256(outExe),
  brandIcon: path.relative(ROOT, ICON).replace(/\\/g, "/"),
  target: "per-user: %LOCALAPPDATA%\\Programs\\PNK Suguan",
  userData: "%LOCALAPPDATA%\\PNK Suguan",
  builtAt: new Date().toISOString(),
};
writeFileSync(
  path.join(ROOT, OUT_DIR, `PNK-Suguan-Setup-${version}.json`),
  `${JSON.stringify(sidecar, null, 2)}\n`,
  "utf8",
);

say("");
say("  installer " + mb(exeBytes));
say("  sha256    " + sidecar.installerSha256);
say("  version   " + version + "  (payload build " + manifest.buildId + ")");
say("");
ok("installer build complete");
