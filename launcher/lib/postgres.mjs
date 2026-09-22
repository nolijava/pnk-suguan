/**
 * Lifecycle for the bundled PostgreSQL cluster.
 *
 * SAFETY: every command is scoped with `-D <DATA_DIR>/pgdata`, so this module can
 * only ever start/stop the cluster that belongs to this installation. It never
 * kills `postgres.exe` by name and never touches another cluster on the machine.
 *
 * No JavaScript database driver is used — the launcher drives the bundled
 * PostgreSQL client tools (pg_ctl / pg_isready / psql / createdb) directly, so the
 * launcher needs no node_modules of its own.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BIND_HOST, DB_USER } from "./config.mjs";
import { paths } from "./paths.mjs";

const PGBIN = paths.pgBin;
const bin = (name) => path.join(PGBIN, `${name}.exe`);
const DATA = paths.pgData;

function pgEnv(password, port) {
  const env = {
    ...process.env,
    PGHOST: BIND_HOST,
    PGSSLMODE: "disable", // loopback only; no TLS in the local cluster
  };
  // Only set these when known. An EMPTY PGPORT is not "unset" to libpq — it
  // overrides the port with "", and initdb's bootstrap backend then dies with
  // `invalid value for parameter "port": ""`. Same trap for an empty password.
  if (port !== undefined && port !== null && port !== "") env.PGPORT = String(port);
  else delete env.PGPORT;
  if (password) env.PGPASSWORD = password;
  else delete env.PGPASSWORD;
  return env;
}

/** Captured command (output on pipes). Safe: these children exit by themselves. */
function capture(cmd, args, { password, port, timeout = 60_000 } = {}) {
  return spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: pgEnv(password, port),
    timeout,
  });
}

/**
 * Command whose child outlives us (pg_ctl start leaves a detached postmaster).
 *
 * On Windows `postgres.exe` inherits the parent's stdio handles; if those are
 * pipes or the live console, spawnSync blocks until the server exits — i.e.
 * forever. A log-file descriptor is safe because nothing waits to drain it.
 */
function runToLog(cmd, args, logFile, { password, port } = {}) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    return spawnSync(cmd, args, {
      stdio: ["ignore", fd, fd],
      encoding: "utf8",
      env: pgEnv(password, port),
    });
  } finally {
    closeSync(fd);
  }
}

export function isInitialized() {
  return existsSync(path.join(DATA, "PG_VERSION"));
}

/**
 * Create the cluster. The superuser password is supplied through a throwaway
 * password file (never argv, never the environment, never a log line) and the
 * file is removed immediately afterwards.
 */
export function initdb(password) {
  mkdirSync(DATA, { recursive: true });
  const pwFile = path.join(paths.runDir, ".pg-initpw");
  writeFileSync(pwFile, `${password}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    const res = runToLog(
      bin("initdb"),
      [
        "-D", DATA,
        "-U", DB_USER,
        `--pwfile=${pwFile}`,
        "--auth-host=scram-sha-256",
        "--auth-local=trust",
        "-E", "UTF8",
        "--locale=C",
      ],
      paths.pgLog,
    );
    if (res.status !== 0) {
      throw new Error(`initdb failed (exit ${res.status}). See ${paths.pgLog}`);
    }
  } finally {
    try {
      unlinkSync(pwFile);
    } catch {
      /* already gone */
    }
  }
}

export function isReady(port) {
  const res = capture(bin("pg_isready"), ["-h", BIND_HOST, "-p", String(port), "-d", "postgres"], {
    port,
    timeout: 10_000,
  });
  return res.status === 0;
}

/** 'running' | 'stopped' | 'uninitialized' — scoped to our own data directory. */
export function status() {
  if (!isInitialized()) return "uninitialized";
  const res = capture(bin("pg_ctl"), ["-D", DATA, "status"], { timeout: 15_000 });
  return res.status === 0 ? "running" : "stopped";
}

export function start(port, password) {
  if (status() === "running") return { started: false };
  // `-l` sends the SERVER's output to pgLog; pg_ctl's own messages go to a
  // separate file. Pointing both at pgLog makes pg_ctl fail on Windows with a
  // sharing violation, and using a PIPE instead would make spawnSync block
  // forever once the detached postmaster inherits the pipe handle.
  const res = runToLog(
    bin("pg_ctl"),
    ["-D", DATA, "-l", paths.pgLog, "-o", `-p ${port} -c listen_addresses=${BIND_HOST}`, "-w", "start"],
    paths.pgCtlLog,
    { password, port },
  );
  if (res.status !== 0) {
    throw new Error(`PostgreSQL failed to start (exit ${res.status}). See ${paths.pgLog} and ${paths.pgCtlLog}`);
  }
  return { started: true };
}

/** Wait until the server accepts connections, or throw with the log location. */
export async function waitUntilReady(port, { attempts = 60, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (isReady(port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `PostgreSQL did not become ready on ${BIND_HOST}:${port} within ${Math.round(
      (attempts * delayMs) / 1000,
    )}s. See ${paths.pgLog}`,
  );
}

/** Graceful stop of OUR cluster only. `-m fast` leaves the data directory clean. */
export function stop() {
  if (status() !== "running") return { stopped: false };
  const res = capture(bin("pg_ctl"), ["-D", DATA, "-m", "fast", "-w", "stop"], { timeout: 60_000 });
  if (res.status !== 0) {
    throw new Error(`PostgreSQL did not stop cleanly (exit ${res.status}). See ${paths.pgLog}`);
  }
  return { stopped: true };
}

export function databaseExists(port, name, password) {
  const res = capture(
    bin("psql"),
    ["-h", BIND_HOST, "-p", String(port), "-U", DB_USER, "-d", "postgres", "-tAc",
      `SELECT 1 FROM pg_database WHERE datname = '${name}'`],
    { password, port },
  );
  return res.status === 0 && res.stdout.trim() === "1";
}

export function createDatabase(port, name, password) {
  const res = capture(
    bin("createdb"),
    ["-h", BIND_HOST, "-p", String(port), "-U", DB_USER, "-E", "UTF8", name],
    { password, port },
  );
  if (res.status !== 0) {
    throw new Error(`could not create database "${name}": ${res.stderr.trim()}`);
  }
}

/** Single scalar query via psql; returns the trimmed value or null on error. */
export function queryScalar(port, sql, password) {
  const res = capture(
    bin("psql"),
    ["-h", BIND_HOST, "-p", String(port), "-U", DB_USER, "-d", "postgres", "-tAc", sql],
    { password, port },
  );
  return res.status === 0 ? res.stdout.trim() : null;
}

export function tableExists(port, db, table, password) {
  const res = capture(
    bin("psql"),
    ["-h", BIND_HOST, "-p", String(port), "-U", DB_USER, "-d", db, "-tAc",
      `SELECT to_regclass('public.${table}') IS NOT NULL`],
    { password, port },
  );
  return res.status === 0 && res.stdout.trim() === "t";
}

export function userCount(port, db, password) {
  const res = capture(
    bin("psql"),
    ["-h", BIND_HOST, "-p", String(port), "-U", DB_USER, "-d", db, "-tAc", "SELECT count(*) FROM users"],
    { password, port },
  );
  return res.status === 0 ? Number(res.stdout.trim()) : null;
}
