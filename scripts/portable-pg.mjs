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
 * Usage:
 *   node scripts/portable-pg.mjs install
 *   node scripts/portable-pg.mjs start-dev | stop-dev | start-test | stop-test
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
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

function fail(msg) {
  console.error(`[portable-pg] ERROR: ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[portable-pg] ${msg}`);
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

function installed() {
  return existsSync(path.join(BIN_DIR, "initdb.exe"));
}

function pickLatest16Version() {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, ".tools", "node", "node_modules", "npm", "bin", "npm-cli.js"),
      "view",
      `${PACKAGE}`,
      "versions",
      "--json",
    ],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
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
  run(
    process.execPath,
    [
      path.join(ROOT, ".tools", "node", "node_modules", "npm", "bin", "npm-cli.js"),
      "install",
      "--prefix",
      NPM_STAGE,
      "--no-audit",
      "--no-fund",
      `${PACKAGE}@${version}`,
    ],
  );
  const nativeDir = path.join(NPM_STAGE, "node_modules", PACKAGE, "native");
  if (!existsSync(path.join(nativeDir, "bin", "initdb.exe"))) {
    fail(`unexpected package layout: ${nativeDir}/bin/initdb.exe missing`);
  }
  const target = path.join(PG_DIR, "pgsql");
  rmSync(target, { recursive: true, force: true });
  if (process.platform === "win32") {
    const copy = spawnSync("cmd.exe", [
      "/c", "xcopy", nativeDir, target, "/E", "/I", "/Q", "/Y",
    ], { stdio: "inherit" });
    if (copy.status !== 0) fail("xcopy of native binaries failed");
  } else {
    run("cp", ["-a", `${nativeDir}/.`, target]);
  }
  if (!existsSync(path.join(BIN_DIR, "initdb.exe"))) {
    fail("copy of native binaries failed");
  }
  rmSync(NPM_STAGE, { recursive: true, force: true });
  writeFileSync(path.join(PG_DIR, "version.txt"), `${version}\n`);
  log(`installed PostgreSQL ${version} → ${target}`);
}

function clusterDir(kind) {
  const dir = path.join(PG_DIR, kind === "dev" ? "pnk-dev" : "pnk-test");
  return dir;
}

function ensureCluster(kind, port, dbName) {
  if (!installed()) cmdInstall();
  const dataDir = clusterDir(kind);
  const firstInit = !existsSync(path.join(dataDir, "PG_VERSION"));
  if (firstInit) {
    log(`initialising cluster ${kind} at ${dataDir}…`);
    mkdirSync(dataDir, { recursive: true });
    const pwfile = path.join(PG_DIR, `.pw-${kind}.tmp`);
    writeFileSync(pwfile, `${PASSWORD}\n`);
    try {
      run(path.join(BIN_DIR, "initdb.exe"), [
        "-D", dataDir,
        "-U", SUPERUSER,
        "--pwfile", pwfile,
        "-E", "UTF8",
        "-A", "scram-sha-256",
      ]);
    } finally {
      rmSync(pwfile, { force: true });
    }
    // Local-only listeners and a dedicated log file.
    appendFileSync(
      path.join(dataDir, "postgresql.conf"),
      `\nlisten_addresses = '127.0.0.1'\nport = ${port}\n`,
    );
  }
  // Start if not running.
  const status = run(
    path.join(BIN_DIR, "pg_ctl.exe"),
    ["-D", dataDir, "status"],
    { capture: true },
  );
  if (status.status !== 0) {
    log(`starting ${kind} cluster on port ${port}…`);
    run(path.join(BIN_DIR, "pg_ctl.exe"), [
      "-D", dataDir,
      "-l", path.join(PG_DIR, `${kind}.log`),
      "-o", `-p ${port}`,
      "start",
    ]);
  }
  // Wait for readiness.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ready = run(
      path.join(BIN_DIR, "pg_isready.exe"),
      ["-h", "127.0.0.1", "-p", String(port), "-U", SUPERUSER],
      { capture: true },
    );
    if (ready.status === 0) break;
    if (Date.now() > deadline) fail(`${kind} cluster did not become ready`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  // Ensure the database exists.
  const list = run(
    path.join(BIN_DIR, "psql.exe"),
    ["-h", "127.0.0.1", "-p", String(port), "-U", SUPERUSER, "-d", "postgres", "-tAc",
      `SELECT 1 FROM pg_database WHERE datname='${dbName}'`],
    { capture: true },
  );
  if ((list.stdout ?? "").trim() !== "1") {
    log(`creating database ${dbName}…`);
    run(path.join(BIN_DIR, "createdb.exe"), [
      "-h", "127.0.0.1", "-p", String(port), "-U", SUPERUSER, dbName,
    ]);
  }
  log(`${kind} ready → postgresql://${SUPERUSER}@127.0.0.1:${port}/${dbName}`);
}

function stopCluster(kind) {
  const dataDir = clusterDir(kind);
  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    log(`${kind} cluster not initialised — nothing to stop`);
    return;
  }
  run(path.join(BIN_DIR, "pg_ctl.exe"), ["-D", dataDir, "-m", "fast", "stop"]);
  log(`${kind} stopped`);
}

const [, , cmd] = process.argv;
switch (cmd) {
  case "install": cmdInstall(); break;
  case "start-dev": ensureCluster("dev", PORT_DEV, DB_DEV); break;
  case "stop-dev": stopCluster("dev"); break;
  case "start-test": ensureCluster("test", PORT_TEST, DB_TEST); break;
  case "stop-test": stopCluster("test"); break;
  default:
    fail("usage: portable-pg.mjs install|start-dev|stop-dev|start-test|stop-test");
}
