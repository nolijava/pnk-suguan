/**
 * Layout resolution for the packaged local deployment.
 *
 * The central invariant: APPLICATION PAYLOAD != USER DATA.
 *
 *   PNK_HOME   the installed program payload (read-only): launcher, bundled
 *              Node, bundled PostgreSQL binaries, the Next.js app.
 *   DATA_DIR   per-machine, per-user mutable state: the PostgreSQL cluster,
 *              generated secrets, logs, run/pid files, future backups.
 *
 * Updating or replacing the application must never touch DATA_DIR.
 */
import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync } from "node:fs";

/** Program payload root — `launcher/lib/` -> package root. */
export const HOME = path.resolve(import.meta.dirname, "..", "..");

/**
 * Mutable state root. Defaults to a per-user location so the program directory
 * can live in Program Files (non-writable, admin-only) and still work.
 * Override with PNK_DATA_DIR (used by tests to build throwaway instances).
 */
export const DATA_DIR = process.env.PNK_DATA_DIR
  ? path.resolve(process.env.PNK_DATA_DIR)
  : path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "PNK Suguan",
    );

const appControlPipe = process.platform === "win32"
  ? `\\\\.\\pipe\\pnk-suguan-${DATA_DIR.replace(/[^a-zA-Z0-9]/g, "-").slice(-64)}`
  : path.join(DATA_DIR, "run", "app-control.pipe");

export const paths = {
  home: HOME,
  data: DATA_DIR,

  // ---- program payload -----------------------------------------------------
  nodeExe: path.join(HOME, "node", process.platform === "win32" ? "node.exe" : "node"),
  pgBin: path.join(HOME, "postgres", "bin"),
  appDir: path.join(HOME, "app"),
  appServer: path.join(HOME, "app", "server.js"),
  migrationsDir: path.join(HOME, "app", "drizzle"),
  migrateTool: path.join(HOME, "app", "_launcher", "migrate.mjs"),
  adminTool: path.join(HOME, "app", "_launcher", "setup-admin.mjs"),

  // ---- user data -----------------------------------------------------------
  pgData: path.join(DATA_DIR, "pgdata"),
  logDir: path.join(DATA_DIR, "logs"),
  runDir: path.join(DATA_DIR, "run"),
  backupDir: path.join(DATA_DIR, "backups"),
  envFile: path.join(DATA_DIR, ".env"),
  configFile: path.join(DATA_DIR, "config.json"),
  appLog: path.join(DATA_DIR, "logs", "app.log"),
  appErr: path.join(DATA_DIR, "logs", "app.err.log"),
  pgLog: path.join(DATA_DIR, "logs", "postgres.log"),
  // pg_ctl's OWN messages must go to a different file than the one passed to
  // `pg_ctl -l` (the server log): on Windows the two handles conflict and
  // startup fails with "The process cannot access the file because it is being
  // used by another process".
  pgCtlLog: path.join(DATA_DIR, "logs", "pg_ctl.log"),
  launcherLog: path.join(DATA_DIR, "logs", "launcher.log"),
  appPidFile: path.join(DATA_DIR, "run", "app.pid"),
  // Same-user named pipe used to request an application-owned graceful shutdown.
  appControlPipe,
  // The supervising launcher process (the one holding the console). Recorded so
  // `stop` can also retire a detached supervisor.
  launcherPidFile: path.join(DATA_DIR, "run", "launcher.pid"),
  // Exclusive lock serializing concurrent `start` invocations.
  startLockFile: path.join(DATA_DIR, "run", "launcher.lock"),
  firstRunPasswordFile: path.join(DATA_DIR, "FIRST-RUN-ADMIN-PASSWORD.txt"),
};

/** Create every writable directory (idempotent). */
export function ensureDataDirs() {
  for (const dir of [
    paths.data,
    paths.logDir,
    paths.runDir,
    paths.backupDir,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** Fail fast with an actionable message if the payload is incomplete. */
export function assertPayloadComplete() {
  const missing = [
    ["bundled Node runtime", paths.nodeExe],
    ["bundled PostgreSQL binaries", path.join(paths.pgBin, "postgres.exe")],
    ["application server (app/server.js)", paths.appServer],
    ["migrations (app/drizzle)", paths.migrationsDir],
    ["migration runner (app/_launcher/migrate.mjs)", paths.migrateTool],
    ["admin bootstrap (app/_launcher/setup-admin.mjs)", paths.adminTool],
  ].filter(([, p]) => !existsSync(p));

  if (missing.length > 0) {
    const list = missing.map(([label, p]) => `  - ${label}\n      expected at ${p}`).join("\n");
    throw new Error(
      `The installation looks incomplete or was moved incorrectly.\nMissing:\n${list}\n\n` +
        "Reinstall the package, or set PNK_DATA_DIR if only the data folder moved.",
    );
  }
}
