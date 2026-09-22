#!/usr/bin/env node
/**
 * Portable PostgreSQL manager for development/testing on machines without
 * Docker or a system PostgreSQL installation.
 *
 * Downloads the Windows x64 binaries of embedded-postgres (user-scope, no
 * Windows service, no admin required), caches them under .pg/, and can
 * start/stop two disposable clusters:
 *   - dev  : database `pnk`,      port from PNK_PG_PORT_DEV  (default 5433)
 *   - test : database `pnk_test`, port from PNK_PG_PORT_TEST (default 5434)
 *
 * IMPORTANT — what this script must NOT depend on
 * -----------------------------------------------
 * The bundled distribution ships exactly three executables:
 *   initdb.exe  pg_ctl.exe  postgres.exe
 * It does NOT ship psql, createdb, pg_isready, pg_dump or pg_restore. Earlier
 * revisions of this script shelled out to pg_isready/psql/createdb for the
 * readiness probe and the database bootstrap, so `start-dev` failed with
 * "dev cluster did not become ready". Readiness and database creation are now
 * done through `pg_ctl` + the `postgres` (postgres-js) driver, which the
 * project already depends on — no absent binary is ever invoked.
 *
 * Client tools for backup/restore (psql, pg_dump, pg_restore, pg_isready,
 * createdb, dropdb) are provisioned separately and on demand by `tools`, which
 * pulls the official version-matched PostgreSQL 16.x Windows binaries and
 * records a provenance manifest at .pg/tools-manifest.json.
 *
 * Usage:
 *   node scripts/portable-pg.mjs install
 *   node scripts/portable-pg.mjs tools
 *   node scripts/portable-pg.mjs start-dev | stop-dev | start-test | stop-test
 *   node scripts/portable-pg.mjs status
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  readdirSync,
  createWriteStream,
  statSync,
  openSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PG_DIR = path.join(ROOT, ".pg");
const BIN_DIR = path.join(PG_DIR, "pgsql", "bin");
const NPM_STAGE = path.join(PG_DIR, "npm");
const PACKAGE = "@embedded-postgres/windows-x64";

const PORT_DEV = Number(process.env.PNK_PG_PORT_DEV ?? 5433);
const PORT_TEST = Number(process.env.PNK_PG_PORT_TEST ?? 5434);
const SUPERUSER = "pnk";
const PASSWORD = "pnk"; // local-only disposable clusters; never used in production
const DB_DEV = "pnk";
const DB_TEST = "pnk_test";

/** Executables the bundled server distribution is REQUIRED to provide. */
const REQUIRED_SERVER_BINS = ["initdb.exe", "pg_ctl.exe", "postgres.exe"];
/** Client tooling used by backup/restore; provided by `tools`, not `install`. */
const CLIENT_BINS = ["psql.exe", "pg_dump.exe", "pg_restore.exe"];
/** Extra conveniences bundled by `tools` when available. */
const EXTRA_CLIENT_BINS = ["pg_isready.exe", "createdb.exe", "dropdb.exe"];

/** PostgreSQL major.minor whose Windows binaries `tools` provisions. */
const PG_TOOLS_VERSION = process.env.PNK_PG_TOOLS_VERSION ?? "16.14";
const EDB_ZIP_URL =
  process.env.PNK_PG_TOOLS_URL ??
  `https://get.enterprisedb.com/postgresql/postgresql-${PG_TOOLS_VERSION}-1-windows-x64-binaries.zip`;
const TOOLS_MANIFEST = path.join(PG_DIR, "tools-manifest.json");

function fail(msg) {
  console.error(`[portable-pg] ERROR: ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[portable-pg] ${msg}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a command whose child may outlive us (`pg_ctl start` leaves a detached
 * postmaster behind) with its output sent to a log FILE rather than a pipe or
 * the inherited console.
 *
 * Why this matters on Windows: `postgres.exe` inherits the parent's stdio
 * handles. If those are pipes (stdio "pipe") or the live console (stdio
 * "inherit"), `spawnSync` blocks until the server exits — which is never — so
 * the CLI hangs after its work is already done. A file descriptor is safe
 * because it has no reader waiting to drain.
 */
function runToLog(cmd, args, logFile) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    return spawnSync(cmd, args, {
      stdio: ["ignore", fd, fd],
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, PGPASSWORD: PASSWORD },
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * Terminate deterministically. Even with the stdio fix above, a detached
 * postmaster or an idle driver handle can keep the event loop alive; a CLI must
 * not linger after its work is finished. stdout is drained first so nothing is
 * truncated when output goes to a pipe.
 */
function finish(code = 0) {
  const exit = () => process.exit(code);
  if (process.stdout.writableLength === 0) exit();
  else process.stdout.once("drain", exit);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: PASSWORD },
    cwd: ROOT,
  });
  if (opts.capture) return res;
  if (res.status !== 0) fail(`${cmd} ${args.join(" ")} exited with ${res.status}`);
  return res;
}

/** Locate npm-cli.js inside the vendored Node runtime, with fallbacks. */
function npmCli() {
  const candidates = [
    path.join(ROOT, ".tools", "node", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  fail(`npm-cli.js not found (looked in: ${candidates.join(", ")})`);
}

/**
 * Preflight: assert every server binary this script actually invokes is
 * present, and report which optional client tools exist. Fails loudly with the
 * exact missing file instead of a downstream "did not become ready" timeout.
 */
function requireServerBins() {
  if (!existsSync(BIN_DIR)) {
    fail(`server binaries missing at ${BIN_DIR} — run: node scripts/portable-pg.mjs install`);
  }
  const missing = REQUIRED_SERVER_BINS.filter((b) => !existsSync(path.join(BIN_DIR, b)));
  if (missing.length > 0) {
    fail(
      `bundled PostgreSQL is incomplete — missing ${missing.join(", ")} in ${BIN_DIR}. ` +
        `Re-run: node scripts/portable-pg.mjs install`,
    );
  }
}

function bin(name) {
  return path.join(BIN_DIR, name);
}

function installed() {
  return existsSync(bin("initdb.exe"));
}

function detectBinaries() {
  if (!existsSync(BIN_DIR)) return [];
  const wanted = [...REQUIRED_SERVER_BINS, ...CLIENT_BINS, ...EXTRA_CLIENT_BINS];
  return readdirSync(BIN_DIR).filter((f) => wanted.includes(f) && f.endsWith(".exe"));
}

function missingClientBins() {
  return CLIENT_BINS.filter((b) => !existsSync(path.join(BIN_DIR, b)));
}

/** Major.minor of the bundled server, e.g. "16.14". */
function serverVersion() {
  const res = run(bin("postgres.exe"), ["--version"], { capture: true });
  const m = /(\d+\.\d+)/.exec(res.stdout ?? "");
  return m ? m[1] : null;
}

// --------------------------------------------------------------------------
// install — fetch the server binaries
// --------------------------------------------------------------------------

function pickLatest16Version() {
  const res = spawnSync(process.execPath, [npmCli(), "view", `${PACKAGE}`, "versions", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (res.status !== 0) fail(`npm view failed: ${res.stderr}`);
  const versions = JSON.parse(res.stdout);
  const v16 = versions.filter((v) => v.startsWith("16."));
  if (v16.length === 0) fail(`no 16.x version of ${PACKAGE} found`);
  return v16[v16.length - 1];
}

function cmdInstall() {
  if (installed()) {
    log("already installed");
    return;
  }
  mkdirSync(PG_DIR, { recursive: true });
  const version = pickLatest16Version();
  log(`installing ${PACKAGE}@${version} via npm (user-scope, no admin)…`);
  rmSync(NPM_STAGE, { recursive: true, force: true });
  run(process.execPath, [
    npmCli(),
    "install",
    "--prefix",
    NPM_STAGE,
    "--no-audit",
    "--no-fund",
    `${PACKAGE}@${version}`,
  ]);
  const nativeDir = path.join(NPM_STAGE, "node_modules", PACKAGE, "native");
  if (!existsSync(path.join(nativeDir, "bin", "initdb.exe"))) {
    fail(`unexpected package layout: ${nativeDir}/bin/initdb.exe missing`);
  }
  const target = path.join(PG_DIR, "pgsql");
  rmSync(target, { recursive: true, force: true });
  if (process.platform === "win32") {
    const copy = spawnSync("cmd.exe", ["/c", "xcopy", nativeDir, target, "/E", "/I", "/Q", "/Y"], {
      stdio: "inherit",
    });
    if (copy.status !== 0) fail("xcopy of native binaries failed");
  } else {
    run("cp", ["-a", `${nativeDir}/.`, target]);
  }
  requireServerBins();
  rmSync(NPM_STAGE, { recursive: true, force: true });
  writeFileSync(path.join(PG_DIR, "version.txt"), `${version}\n`);
  log(`installed PostgreSQL ${version} → ${target}`);
}

// --------------------------------------------------------------------------
// tools — provision version-matched client binaries + provenance manifest
// --------------------------------------------------------------------------

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) fail(`download failed: HTTP ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

/**
 * Extract only pgsql/bin/*.exe (client tools) and any pgsql/bin/*.dll that our
 * bundled distribution does not already provide. Extracting the whole archive
 * would unpack ~1.5 GB for ~15 MB of useful content, so we select entries from
 * the zip central directory instead.
 */
function extractTools(zipPath) {
  if (process.platform !== "win32") {
    // Non-Windows path is only used for smoke checks; -j flattens directories.
    const list = run("unzip", ["-Z1", zipPath], { capture: true }).stdout ?? "";
    const wanted = list
      .split(/\r?\n/)
      .filter((n) => /^pgsql\/bin\/[^/]+\.(exe|dll)$/.test(n))
      .filter((n) => {
        const base = path.basename(n);
        if (base.endsWith(".exe")) {
          return [...CLIENT_BINS, ...EXTRA_CLIENT_BINS].includes(base);
        }
        return !existsSync(path.join(BIN_DIR, base));
      });
    if (wanted.length === 0) fail("no client binaries matched inside the archive");
    run("unzip", ["-j", "-o", zipPath, ...wanted, "-d", BIN_DIR]);
    return wanted.map((n) => path.basename(n));
  }

  const exeNames = [...CLIENT_BINS, ...EXTRA_CLIENT_BINS];
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
$dest = '${BIN_DIR.replace(/'/g, "''")}'
$exe = @(${exeNames.map((e) => `'${e}'`).join(",")})
$extracted = New-Object System.Collections.Generic.List[string]
try {
  foreach ($e in $zip.Entries) {
    if ($e.FullName -notmatch '^pgsql/bin/[^/]+\\.(exe|dll)$') { continue }
    $name = [System.IO.Path]::GetFileName($e.FullName)
    if ($name -like '*.exe') {
      if ($exe -notcontains $name) { continue }
    } elseif (Test-Path (Join-Path $dest $name)) {
      continue  # keep the DLLs our server distribution already ships
    }
    $out = Join-Path $dest $name
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $out, $true)
    $extracted.Add($name)
  }
} finally { $zip.Dispose() }
$extracted | ForEach-Object { Write-Output $_ }
`;
  const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) fail(`zip extraction failed: ${res.stderr || res.stdout}`);
  const names = (res.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) fail("no client binaries matched inside the archive");
  return names;
}

async function cmdTools() {
  requireServerBins();
  if (process.platform !== "win32") {
    log("note: `tools` is designed for the Windows deployment target");
  }
  const expected = serverVersion();
  if (!expected) fail("could not determine the bundled server version from postgres.exe --version");

  const already = CLIENT_BINS.every((b) => existsSync(path.join(BIN_DIR, b)));
  if (already && !FORCE) {
    const probe = run(bin("psql.exe"), ["--version"], { capture: true });
    const got = /(\d+\.\d+)/.exec(probe.stdout ?? "")?.[1];
    if (got === expected) {
      log(`client tools already present and version-matched (${got})`);
      return;
    }
    log(`client tools present but version-mismatched (have ${got}, want ${expected}) — re-provisioning`);
  }

  const zipPath = path.join(PG_DIR, `pg-tools-${PG_TOOLS_VERSION}.zip`);
  mkdirSync(PG_DIR, { recursive: true });
  log(`downloading PostgreSQL ${PG_TOOLS_VERSION} Windows binaries…`);
  log(`  ${EDB_ZIP_URL}`);
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  try {
    await download(EDB_ZIP_URL, zipPath);
  } catch (err) {
    fail(`could not download the client tools (offline?): ${err?.message ?? err}`);
  }
  const bytes = statSync(zipPath).size;
  const digest = sha256File(zipPath);
  log(`downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256=${digest}`);

  const extracted = extractTools(zipPath);
  requireServerBins();

  // Version-match assertion: the extracted client must agree with the server.
  const psqlOut = run(bin("psql.exe"), ["--version"], { capture: true });
  const got = /(\d+\.\d+)/.exec(psqlOut.stdout ?? "")?.[1];
  if (got !== expected) {
    fail(
      `client/server version mismatch after extraction: psql reports ${got}, ` +
        `bundled server is ${expected}. Set PNK_PG_TOOLS_VERSION to match.`,
    );
  }
  for (const tool of ["pg_dump.exe", "pg_restore.exe"]) {
    const out = run(path.join(BIN_DIR, tool), ["--version"], { capture: true });
    if (out.status !== 0) fail(`${tool} does not run after extraction: ${out.stderr}`);
  }

  const manifest = {
    source: EDB_ZIP_URL,
    archive: path.basename(zipPath),
    bytes,
    sha256: digest,
    // EDB does not publish a per-file public digest for this archive, so the
    // hash above is recorded on first use and version-matched below. Pinning an
    // out-of-band digest is an L3 hardening item.
    sha256Provenance: "recorded-on-first-use (no upstream digest published)",
    pgVersion: got,
    serverVersion: expected,
    versionMatched: got === expected,
    extracted,
    extractedAt: new Date().toISOString(),
  };
  writeFileSync(TOOLS_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(PG_DIR, `${path.basename(zipPath, ".zip")}.sha256`), `${digest}  ${path.basename(zipPath)}\n`);
  rmSync(zipPath, { force: true });
  log(`client tools ready → ${BIN_DIR}`);
  log(`provenance manifest → ${TOOLS_MANIFEST}`);
}

// --------------------------------------------------------------------------
// cluster lifecycle — pg_ctl + postgres-js only, no absent binaries
// --------------------------------------------------------------------------

function clusterDir(kind) {
  return path.join(PG_DIR, kind === "dev" ? "pnk-dev" : "pnk-test");
}

/** Readiness probe: real TCP connect + a successful postgres-js handshake. */
async function waitForReady(kind, port, dbName, deadlineMs) {
  let lastError = "no attempt made";
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const reachable = await new Promise((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port });
      const done = (ok) => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(1500);
      sock.once("connect", () => done(true));
      sock.once("timeout", () => done(false));
      sock.once("error", () => done(false));
    });
    if (reachable) {
      try {
        const sql = await connect(dbName);
        try {
          await sql`select 1`;
          return;
        } finally {
          await sql.end({ timeout: 5 });
        }
      } catch (err) {
        lastError = err?.message ?? String(err);
      }
    } else {
      lastError = `TCP 127.0.0.1:${port} not accepting connections`;
    }
    if (Date.now() > deadline) {
      const hint = existsSync(path.join(PG_DIR, `${kind}.log`))
        ? ` — see ${path.join(PG_DIR, `${kind}.log`)}`
        : "";
      fail(`${kind} cluster did not become ready (${lastError})${hint}`);
    }
    sleep(400);
  }
}

async function connect(dbName) {
  const { default: postgres } = await import("postgres");
  return postgres({
    host: "127.0.0.1",
    port: currentPort,
    database: dbName,
    username: SUPERUSER,
    password: PASSWORD,
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
    onnotice: () => {},
  });
}

let currentPort = PORT_DEV;

async function ensureCluster(kind, port, dbName) {
  requireServerBins();
  const dataDir = clusterDir(kind);
  const firstInit = !existsSync(path.join(dataDir, "PG_VERSION"));
  if (firstInit) {
    log(`initialising cluster ${kind} at ${dataDir}…`);
    mkdirSync(dataDir, { recursive: true });
    const pwfile = path.join(PG_DIR, `.pw-${kind}.tmp`);
    writeFileSync(pwfile, `${PASSWORD}\n`);
    try {
      run(bin("initdb.exe"), [
        "-D", dataDir,
        "-U", SUPERUSER,
        "--pwfile", pwfile,
        "-E", "UTF8",
        "-A", "scram-sha-256",
      ]);
    } finally {
      rmSync(pwfile, { force: true });
    }
    // Local-only listeners and a dedicated port.
    appendFileSync(
      path.join(dataDir, "postgresql.conf"),
      `\nlisten_addresses = '127.0.0.1'\nport = ${port}\n`,
    );
  }
  currentPort = port;

  const status = run(bin("pg_ctl.exe"), ["-D", dataDir, "status"], { capture: true });
  if (status.status !== 0) {
    log(`starting ${kind} cluster on port ${port}…`);
    const ctlLog = path.join(PG_DIR, `${kind}-ctl.log`);
    // pg_ctl performs its own startup wait via libpq; no pg_isready required.
    const start = runToLog(
      bin("pg_ctl.exe"),
      ["-D", dataDir, "-l", path.join(PG_DIR, `${kind}.log`), "-o", `-p ${port}`, "start"],
      ctlLog,
    );
    if (start.status !== 0) {
      const tail = existsSync(ctlLog)
        ? readFileSync(ctlLog, "utf8").trim().split(/\r?\n/).slice(-8).join("\n")
        : "";
      fail(`pg_ctl start failed for the ${kind} cluster${tail ? `:\n${tail}` : ""}`);
    }
  }

  await waitForReady(kind, port, "postgres", 60_000);

  // Ensure the application database exists. Identifiers cannot be bound as
  // parameters, so validate strictly against the known-good constant first.
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) fail(`refusing to create suspicious database name: ${dbName}`);
  const sql = await connect("postgres");
  let exists = false;
  try {
    const rows = await sql`select 1 as present from pg_database where datname = ${dbName}`;
    exists = rows.length > 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (!exists) {
    log(`creating database ${dbName}…`);
    const admin = await connect("postgres");
    try {
      // Safe: dbName matched /^[a-z_][a-z0-9_]*$/ above.
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
  log(`${kind} ready → postgresql://${SUPERUSER}@127.0.0.1:${port}/${dbName}`);
}

function stopCluster(kind) {
  requireServerBins();
  const dataDir = clusterDir(kind);
  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    log(`${kind} cluster not initialised — nothing to stop`);
    return;
  }
  run(bin("pg_ctl.exe"), ["-D", dataDir, "-m", "fast", "stop"]);
  log(`${kind} stopped`);
}

function cmdStatus() {
  const have = detectBinaries();
  log(`bundled server binaries (${BIN_DIR}):`);
  log(`  ${have.length ? have.join(", ") : "(none — run install)"}`);
  const missing = missingClientBins();
  log(
    missing.length === 0
      ? "client tools: complete (psql, pg_dump, pg_restore)"
      : `client tools: MISSING ${missing.join(", ")} — backup/restore unavailable; run: node scripts/portable-pg.mjs tools`,
  );
  if (existsSync(TOOLS_MANIFEST)) {
    try {
      const m = JSON.parse(readFileSync(TOOLS_MANIFEST, "utf8"));
      log(`tools manifest: PG ${m.pgVersion} (matched=${m.versionMatched}) sha256=${m.sha256.slice(0, 16)}…`);
    } catch {
      log("tools manifest: unreadable");
    }
  }
  if (!existsSync(BIN_DIR)) return;
  for (const [kind, port] of [["dev", PORT_DEV], ["test", PORT_TEST]]) {
    const dataDir = clusterDir(kind);
    if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
      log(`${kind} cluster: not initialised`);
      continue;
    }
    const res = run(bin("pg_ctl.exe"), ["-D", dataDir, "status"], { capture: true });
    log(`${kind} cluster: ${res.status === 0 ? "running" : "stopped"} (port ${port})`);
  }
}

const [, , cmd] = process.argv;
const FORCE = process.argv.includes("--force");
switch (cmd) {
  case "install":
    cmdInstall();
    break;
  case "tools":
    await cmdTools();
    break;
  case "start-dev":
    await ensureCluster("dev", PORT_DEV, DB_DEV);
    break;
  case "stop-dev":
    stopCluster("dev");
    break;
  case "start-test":
    await ensureCluster("test", PORT_TEST, DB_TEST);
    break;
  case "stop-test":
    stopCluster("test");
    break;
  case "status":
    cmdStatus();
    break;
  default:
    fail("usage: portable-pg.mjs install|tools|start-dev|stop-dev|start-test|stop-test|status");
}

finish(0);
