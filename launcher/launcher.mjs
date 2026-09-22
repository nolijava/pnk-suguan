#!/usr/bin/env node
/**
 * PNK Suguan System — local launcher.
 *
 *   PNK Suguan Launcher  ->  bundled Node 22  ->  Next.js production server
 *                        ->  bundled PostgreSQL 16  ->  default browser
 *
 * Startup order is deliberate: PostgreSQL must be accepting connections before
 * migrations run, and the app must answer /api/health before the browser opens.
 *
 * Commands:
 *   start (default)   ensure database + services are up, then open the browser
 *   stop              gracefully stop the app and this installation's PostgreSQL
 *   status            report what is running without changing anything
 *
 * Flags:
 *   --no-browser      do not open the browser (used by tests/automation)
 *   --foreground      keep the console attached and stop everything on exit
 *                     (this is the default; there is no detached mode)
 *
 * Lifecycle guarantees (L4):
 *   - a `start` that finds the stack already healthy reports it and opens the
 *     browser instead of launching a second server or cluster;
 *   - concurrent launches are serialized by an exclusive lock in run/, and a
 *     lock left behind by a crashed launcher is reclaimed (never blocks startup);
 *   - every pid this launcher signals is verified against its command line first,
 *     so a recycled pid is never killed;
 *   - `stop` also retires a detached supervisor process;
 *   - a failed startup stops PostgreSQL rather than orphaning a postmaster.
 *
 * SECURITY: secrets are read from DATA_DIR/.env and only ever passed to child
 * processes. Nothing sensitive is printed or written to a log.
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureDataDirs, paths, assertPayloadComplete } from "./lib/paths.mjs";
import { initLog, log } from "./lib/log.mjs";
import {
  appEnv,
  ensureSecrets,
  generateAdminPassword,
  resolvePorts,
  BIND_HOST,
  DB_NAME,
} from "./lib/config.mjs";
import * as pg from "./lib/postgres.mjs";

const args = process.argv.slice(2);
const command = ["start", "stop", "status"].includes(args[0]) ? args[0] : "start";
const noBrowser = args.includes("--no-browser");

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

function readPid(file) {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but owned by another user
  }
}

/**
 * Confirm a pid is really OUR app before signalling it. PIDs get reused, so the
 * command line must reference this installation's app directory.
 */
function isOurApp(pid) {
  if (!isAlive(pid)) return false;
  if (process.platform !== "win32") return true;
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
    { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 15_000 },
  );
  const cmdline = (res.stdout || "").trim();
  if (!cmdline) return false;
  return cmdline.includes("server.js") && cmdline.toLowerCase().includes(paths.appDir.toLowerCase());
}

/**
 * Confirm a pid is a launcher process belonging to THIS installation before
 * signalling it (PIDs are recycled, and a plain `node` could be anything).
 */
function isOurLauncher(pid) {
  if (!isAlive(pid)) return false;
  if (process.platform !== "win32") return true;
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
    { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 15_000 },
  );
  const cmdline = (res.stdout || "").trim().toLowerCase();
  if (!cmdline) return false;
  return cmdline.includes("launcher.mjs") && cmdline.includes(paths.home.toLowerCase());
}

async function healthOk(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://${BIND_HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (res.status !== 200) return false;
    const body = await res.json();
    return body?.ready === true;
  } catch {
    return false;
  }
}

async function waitForHealth(port, { attempts = 90, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    // eslint-disable-next-line no-await-in-loop
    if (await healthOk(port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function currentState() {
  const cfg = readConfigSafe();
  const appPort = cfg.appPort;
  const pid = readPid(paths.appPidFile);
  const running = pid ? isOurApp(pid) : false;
  return { appPort, pgPort: cfg.pgPort, pid, running };
}

function readConfigSafe() {
  try {
    return JSON.parse(readFileSync(paths.configFile, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Which build is installed. Present only in a packaged installation, where the
 * packager writes BUILD-MANIFEST.json at the payload root; in a source checkout
 * there is nothing to report and status simply omits the line. Never contains
 * secrets.
 */
function readBuildInfoSafe() {
  try {
    const m = JSON.parse(readFileSync(path.join(paths.home, "BUILD-MANIFEST.json"), "utf8"));
    return m && m.buildId ? m : null;
  } catch {
    return null;
  }
}

async function cmdStatus() {
  const { appPort, pgPort, pid, running } = await currentState();
  const pgState = pg.status();
  log.banner("PNK Suguan System — status");
  log.info(`data folder      ${paths.data}`);
  log.info(`application      ${running ? `running (pid ${pid})` : "stopped"}`);
  log.info(`app url          ${appPort ? `http://${BIND_HOST}:${appPort}` : "(not configured yet)"}`);
  log.info(`database cluster ${pgState}${pgPort ? ` on port ${pgPort}` : ""}`);
  const build = readBuildInfoSafe();
  if (build) log.info(`build            ${build.appVersion ?? "unknown"} (${build.buildId})`);
  if (running && appPort) log.info(`health           ${(await healthOk(appPort)) ? "ready" : "not ready"}`);
  return 0;
}

async function cmdStop() {
  initLog(paths.launcherLog);
  log.banner("PNK Suguan System — stopping");
  const { pid, running } = await currentState();

  if (running) {
    log.step(`stopping application (pid ${pid})`);
    await stopApp(pid);
    for (let i = 0; i < 20 && isAlive(pid); i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }
    if (isAlive(pid)) {
      log.warn("application did not exit in time; terminating");
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    log.ok("application stopped");
  } else {
    log.info("application was not running");
    try {
      rmSync(paths.appPidFile);
    } catch {
      /* nothing to clean */
    }
  }

  const pgState = pg.status();
  if (pgState === "running") {
    log.step("stopping PostgreSQL (graceful, fast shutdown)");
    pg.stop();
    log.ok("PostgreSQL stopped — data directory left clean");
  } else {
    log.info(`PostgreSQL was not running (${pgState})`);
  }

  // Finally retire the supervising launcher if one is still holding the console
  // (the normal case when it was started detached by automation). The pid is
  // verified against the command line first, so a recycled pid belonging to some
  // unrelated process is never signalled — the file is just cleared.
  const supervisor = readPid(paths.launcherPidFile);
  if (supervisor && supervisor !== process.pid) {
    if (isOurLauncher(supervisor)) {
      log.step(`stopping the launcher supervisor (pid ${supervisor})`);
      try {
        process.kill(supervisor);
        log.ok("launcher supervisor stopped");
      } catch {
        log.info("launcher supervisor had already exited");
      }
    } else {
      log.info("clearing a stale launcher pid file");
    }
  }
  rmSync(paths.launcherPidFile, { force: true });
  rmSync(paths.startLockFile, { force: true });

  return 0;
}

/** Ask the app to close its own HTTP server before using the legacy fallback. */
async function stopApp(pid) {
  if (process.platform === "win32") {
    const acknowledged = await requestAppShutdown();
    if (acknowledged) return;

    // The fallback is retained for older payloads or a broken control channel;
    // new payloads should take the application-owned path above.
    spawnSync("taskkill", ["/PID", String(pid), "/T"], { stdio: "ignore", timeout: 20_000 });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function requestAppShutdown(timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const socket = net.createConnection(paths.appControlPipe);
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => {
      connected = true;
      socket.end("shutdown\n");
    });
    socket.on("data", (chunk) => {
      if (String(chunk).includes("ok")) finish(true);
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => {
      if (connected) finish(true);
      else finish(false);
    });
  });
}

async function cmdStart() {
  ensureDataDirs();
  initLog(paths.launcherLog);
  log.banner("PNK Suguan System");

  let adminProvisioned = false;
  let startupLock = null;

  try {
    assertPayloadComplete();

    const { env, created } = ensureSecrets();
    if (created) log.ok("generated this machine's secrets (stored in the data folder, never logged)");

    // Already running? Just surface it — never start a second server or cluster.
    const before = await currentState();
    if (before.running && before.appPort && (await healthOk(before.appPort))) {
      const url = `http://${BIND_HOST}:${before.appPort}`;
      log.ok(`already running (pid ${before.pid})`);
      log.info(url);
      if (!noBrowser) openBrowser(url);
      return 0;
    }
    if (before.pid && !before.running) {
      log.warn("removing a stale application pid file");
      try {
        rmSync(paths.appPidFile);
      } catch {
        /* ignore */
      }
    }

    // Serialize concurrent launches. Without this, two double-clicks landing in
    // the same moment both see "not running" and both try to initdb a cluster.
    startupLock = await acquireStartLock();
    if (!startupLock) {
      log.fail("another launch is still starting up — wait a moment and run this again");
      return 1;
    }

    // Re-check under the lock: the launcher we waited for may have just
    // finished, in which case there is simply nothing left to do.
    const settled = await currentState();
    if (settled.running && settled.appPort && (await healthOk(settled.appPort))) {
      const url = `http://${BIND_HOST}:${settled.appPort}`;
      log.ok(`already running (pid ${settled.pid})`);
      log.info(url);
      if (!noBrowser) openBrowser(url);
      startupLock.release();
      startupLock = null;
      return 0;
    }

    const { pgPort, appPort } = await resolvePorts();
    if (appPort !== 3210) log.info(`preferred app port busy — using ${appPort}`);
    if (pgPort !== 55432) log.info(`preferred database port busy — using ${pgPort}`);

    // 1. PostgreSQL ---------------------------------------------------------
    if (!pg.isInitialized()) {
      log.step("initializing the local database cluster (first run)");
      pg.initdb(env.PNK_DB_PASSWORD);
      log.ok("database cluster created");
    }
    log.step(`starting PostgreSQL on ${BIND_HOST}:${pgPort}`);
    pg.start(pgPort, env.PNK_DB_PASSWORD);
    await pg.waitUntilReady(pgPort);
    log.ok("PostgreSQL ready");

    // 2. Database + migrations ---------------------------------------------
    if (!pg.databaseExists(pgPort, DB_NAME, env.PNK_DB_PASSWORD)) {
      log.step(`creating database "${DB_NAME}"`);
      pg.createDatabase(pgPort, DB_NAME, env.PNK_DB_PASSWORD);
      log.ok("database created");
    }
    log.step("applying database migrations");
    runTool("migrate", env, pgPort);
    log.ok("migrations up to date");

    // 3. First-run administrator -------------------------------------------
    if (pg.tableExists(pgPort, DB_NAME, "users", env.PNK_DB_PASSWORD) &&
        pg.userCount(pgPort, DB_NAME, env.PNK_DB_PASSWORD) === 0) {
      log.step("provisioning the initial administrator (first run)");
      // The password is generated HERE, never baked into the package, and is
      // handed to the real bootstrap through a password FILE (so it never shows
      // up in a process listing or an environment dump). The bootstrap itself
      // reads INITIAL_ADMIN_EMAIL + INITIAL_ADMIN_PASSWORD_FILE.
      const adminPassword = generateAdminPassword();
      const pwFile = path.join(paths.runDir, ".initial-admin-pw");
      writeFileSync(pwFile, `${adminPassword}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        runTool("admin", env, pgPort, {
          capture: true,
          extraEnv: { INITIAL_ADMIN_EMAIL: env.INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD_FILE: pwFile },
        });
      } finally {
        rmSync(pwFile, { force: true });
      }
      // Left for the operator to read once, then delete. Only the PATH is logged.
      writeFileSync(
        paths.firstRunPasswordFile,
        [
          "PNK Suguan System — initial administrator (one-time)",
          "",
          `email:    ${env.INITIAL_ADMIN_EMAIL}`,
          `password: ${adminPassword}`,
          "",
          "Sign in, change the password when prompted, then DELETE THIS FILE.",
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      log.ok("initial administrator created");
      adminProvisioned = true;
    }

    // 4. Application --------------------------------------------------------
    log.step(`starting the application on ${BIND_HOST}:${appPort}`);
    const child = spawn(
      process.execPath,
      ["--require", path.join(paths.home, "launcher", "lib", "app-shutdown.cjs"), paths.appServer],
      {
      cwd: paths.appDir,
      env: {
        ...process.env,
        ...appEnv(env, { pgPort, appPort }),
        PNK_APP_CONTROL_PIPE: paths.appControlPipe,
      },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", openLogFd(paths.appLog), openLogFd(paths.appErr)],
      },
    );
    child.unref();
    writeFileSync(paths.appPidFile, String(child.pid), "utf8");

    if (!(await waitForHealth(appPort))) {
      log.fail(`the application did not become ready. See ${paths.appErr}`);
      return 1;
    }
    log.ok("application ready");

    // Startup is complete — let go of the lock so a later launch takes the fast
    // "already running" path instead of waiting on us.
    if (startupLock) {
      startupLock.release();
      startupLock = null;
    }
    writeFileSync(paths.launcherPidFile, String(process.pid), "utf8");

    const url = `http://${BIND_HOST}:${appPort}`;
    if (!noBrowser) {
      openBrowser(url);
      log.ok("opened the default browser");
    }
    log.banner(`      ${url}`);
    if (adminProvisioned) {
      log.warn("a one-time administrator password was just written to:");
      log.warn(`  ${paths.firstRunPasswordFile}`);
      log.warn("sign in with it, change it when prompted, then delete that file.");
    } else if (existsSync(paths.firstRunPasswordFile)) {
      // Left over from an earlier first run and never cleaned up — not a new secret.
      log.info(`administrator password file still present: ${paths.firstRunPasswordFile}`);
      log.info("delete it once you no longer need it.");
    }
    log.info("Leave this window open. Close it (or run stop) to shut everything down.");

    await holdUntilShutdown();
    return 0;
  } catch (err) {
    if (startupLock) startupLock.release();
    rmSync(paths.launcherPidFile, { force: true });
    log.fail(err instanceof Error ? err.message : String(err));
    // Never leave a half-started stack behind: if startup failed after the
    // cluster came up, stop it rather than orphaning a postmaster that the user
    // has no way to see. The data directory is preserved, so a retry resumes.
    try {
      if (pg.status() === "running") {
        log.step("startup failed — stopping PostgreSQL so nothing is left running");
        pg.stop();
        log.ok("PostgreSQL stopped");
      }
    } catch (stopErr) {
      log.warn(`could not stop PostgreSQL automatically: ${stopErr instanceof Error ? stopErr.message : stopErr}`);
      log.warn(`stop it manually with: "${path.join(paths.home, "Stop PNK Suguan.cmd")}"`);
    }
    log.fail(`log: ${paths.launcherLog}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// startup lock — serializes concurrent launches
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Take the startup lock, or wait for the launcher that holds it.
 *
 * Two double-clicks at the same moment would otherwise both see "not running"
 * and both try to initdb/start PostgreSQL. The lock is an exclusive file whose
 * contents are the holder's pid: a lock left by a crashed launcher is detected
 * and reclaimed rather than blocking startup forever.
 *
 * Returns { release } or null if another launcher is still starting after waitMs.
 */
async function acquireStartLock({ waitMs = 60_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(paths.startLockFile, "wx");
      writeFileSync(fd, String(process.pid));
      const lock = {
        release() {
          try {
            const held = Number(readFileSync(paths.startLockFile, "utf8").trim());
            if (held === process.pid) rmSync(paths.startLockFile, { force: true });
          } catch {
            /* already gone */
          }
          try {
            closeSync(fd);
          } catch {
            /* already closed */
          }
        },
      };
      return lock;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const holder = readPid(paths.startLockFile);
      if (!holder || !isOurLauncher(holder)) {
        // Stale lock from a crashed or recycled pid — reclaim it.
        try {
          rmSync(paths.startLockFile, { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      if (Date.now() > deadline) return null;
      await sleep(pollMs);
    }
  }
}

function openLogFd(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  return openSync(file, "a");
}

/**
 * Run a bundled Node tool (migration runner / admin bootstrap) from the app
 * directory so its imports resolve against the traced node_modules.
 * Returns captured stdout when requested (the one-time admin password — which is
 * written straight to a file and never logged).
 */
function runTool(name, env, pgPort, { capture = false, extraEnv = {} } = {}) {
  const tool = name === "migrate" ? paths.migrateTool : paths.adminTool;
  const res = spawnSync(process.execPath, [tool], {
    cwd: paths.appDir,
    env: { ...process.env, ...appEnv(env, { pgPort, appPort: 0 }), ...extraEnv },
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", openLogFd(paths.appLog), openLogFd(paths.appErr)],
    encoding: "utf8",
    timeout: 10 * 60_000,
  });
  if (res.status !== 0) {
    const detail = capture ? (res.stderr || "").trim() : `see ${paths.appErr}`;
    throw new Error(`${name} failed (exit ${res.status}). ${detail}`);
  }
  return capture ? (res.stdout || "").trim() : "";
}

/** Keep the launcher in the foreground and tear services down on exit. */
function holdUntilShutdown() {
  return new Promise((resolve) => {
    let done = false;
    // The app and the postmaster are both detached, so nothing else holds the
    // event loop open. Without an explicit handle Node would drain and exit
    // ("unsettled top-level await"), dropping the launcher's shutdown control.
    const keepAlive = setInterval(() => {}, 60_000);
    const shutdown = async (reason) => {
      if (done) return;
      done = true;
      clearInterval(keepAlive);
      log.banner(`\nPNK Suguan System — shutting down (${reason})`);
      const pid = readPid(paths.appPidFile);
      const alive = pid && isOurApp(pid);
      if (alive) {
        log.step("stopping application");
        await stopApp(pid);
      } else if (pid) {
        log.info("application was already stopped");
      }
      if (pg.status() === "running") {
        log.step("stopping PostgreSQL");
        try {
          pg.stop();
          log.ok("PostgreSQL stopped cleanly");
        } catch (err) {
          log.warn(err instanceof Error ? err.message : String(err));
        }
      }
      // Leave no stale bookkeeping behind for the next launch.
      rmSync(paths.launcherPidFile, { force: true });
      rmSync(paths.startLockFile, { force: true });
      resolve();
    };

    process.once("SIGINT", () => void shutdown("interrupted"));
    process.once("SIGTERM", () => void shutdown("terminated"));
    process.once("SIGBREAK", () => void shutdown("console closed"));
    if (process.platform === "win32") {
      process.once("SIGHUP", () => void shutdown("console closed"));
    }
  });
}

// ---------------------------------------------------------------------------

const code =
  command === "stop" ? await cmdStop() : command === "status" ? await cmdStatus() : await cmdStart();
process.exit(code ?? 0);
