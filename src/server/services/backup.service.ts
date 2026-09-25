import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { closeDbClient } from "@/server/db/client";
import { audit } from "./audit.service";
import { pickOpenFile, pickSavePath } from "./native-dialog.service";
import type { SessionUser } from "@/server/auth/session";

const execFileAsync = promisify(execFile);

/**
 * Update #18 — operator Backup / Restore of the whole application database.
 *
 * Mechanics (mirrors the launcher's posture):
 *  - pg_dump (custom format) → the per-user backups folder
 *    (`%LOCALAPPDATA%\PNK Suguan\backups`, PNK_DATA_DIR-aware — the same folder
 *    `launcher/lib/paths.mjs` owns). Payload ≠ user data: backups never land in
 *    the program directory.
 *  - Restore is DESTRUCTIVE and guarded five ways:
 *      1. RBAC   — `backups.restore` (ADMIN / SUPER_ADMIN); VIEWER can never.
 *      2. Strong confirm — the typed confirmation must equal the file name.
 *      3. Integrity validation — `pg_restore --list` must read the archive
 *         BEFORE anything is touched; a corrupt file aborts with no writes.
 *      4. Safety backup — a `pre-restore-*.dump` of the CURRENT database is
 *         taken first; if it fails, the restore never runs.
 *      5. Target guard — the restore target must be the app's own LOCAL PNK
 *         database (loopback + `schema_migrations` signature present).
 *  - Both operations are audited (CREATED_BACKUP / RESTORED_BACKUP, plus
 *    BACKUP_FAILED / RESTORE_FAILED on failure).
 *  - After a successful restore the application requires a restart; in a
 *    packaged run (control pipe present) a graceful exit is scheduled so the
 *    launcher can bring it back up on the next start.
 *
 * Post-release update (Backup location options + Restore from other location):
 *  - Create Backup can target a user-chosen location (native Windows "Save
 *    As" dialog via the trusted backend). The SAME pg_dump pipeline,
 *    validation, metadata and audit run for every destination — there is
 *    exactly one backup mechanism.
 *  - Restore can read a backup from ANY local location (native "Open"
 *    dialog). A picked file is UNTRUSTED INPUT until validated: extension
 *    never grants trust — the PGDMP header and `pg_restore --list` must both
 *    pass before the strong-confirm restore can run.
 *  - The browser never touches the filesystem: dialogs run server-side and
 *    the UI only ever references TTL-bound, owner-bound pick tokens that map
 *    to exactly one picked path (consumed on success; retryable on failure).
 */

export interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
  /** Directory the archive actually lives in (default or user-chosen). */
  destination?: string;
}

export interface RestoreResult {
  restored: string;
  safetyBackup: string;
  restartRequired: true;
  /** "default" = the backups folder; "external" = a user-picked file. */
  source?: "default" | "external";
  targetDatabase?: string;
}

/** Read-only report of a (possibly untrusted) backup file. */
export interface BackupFileInspect {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  sha256: string;
  valid: boolean;
  /** Number of TOC entries when the archive reads cleanly. */
  entries: number | null;
  error: string | null;
}

const SAFE_NAME = /^[A-Za-z0-9._-]+\.dump$/;
/** User-chosen custom names (Save dialog): still path-safe, still *.dump. */
const SAFE_CUSTOM_NAME = /^[^\\/:*?"<>|\r\n]{1,180}\.dump$/i;

type BackupActor = Pick<SessionUser, "userId">;

/** Backups folder — same layout as launcher/lib/paths.mjs `backupDir`. */
export function backupDir(): string {
  if (process.env.PNK_BACKUP_DIR) return path.resolve(process.env.PNK_BACKUP_DIR);
  const dataDir =
    process.env.PNK_DATA_DIR ??
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "PNK Suguan");
  return path.join(dataDir, "backups");
}

/** PostgreSQL client tools (pg_dump / pg_restore) for this deployment. */
function pgBinDir(): string {
  const candidates = [
    process.env.PNK_PG_BIN,
    // dev / test checkout (scripts/portable-pg.mjs `tools`)
    path.join(process.cwd(), ".pg", "pgsql", "bin"),
    // packaged: the app runs from HOME/app, tools live at HOME/postgres/bin
    path.join(process.cwd(), "postgres", "bin"),
    path.join(process.cwd(), "..", "postgres", "bin"),
  ].filter((c): c is string => Boolean(c));
  for (const dir of candidates) {
    if (existsSync(path.join(dir, exeName("pg_dump")))) return dir;
  }
  throw new ValidationError(
    "PostgreSQL backup tools (pg_dump) were not found. Set PNK_PG_BIN to the PostgreSQL bin directory.",
  );
}

function exeName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/** Connection settings for the child tools. The password travels ONLY in the
 *  child environment (PGPASSWORD) — never in argv, never in a log. */
function pgEnv(): NodeJS.ProcessEnv {
  const url = process.env.DATABASE_URL ?? process.env.PNK_TEST_DATABASE_URL;
  if (!url) throw new ValidationError("DATABASE_URL is not set");
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname || "127.0.0.1",
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    // loopback-only clusters; the launcher disables TLS the same way
    PGSSLMODE: "disable",
  };
}

async function runTool(bin: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(path.join(pgBinDir(), exeName(bin)), args, {
      env: pgEnv(),
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr ?? e.message ?? "").trim().split("\n").slice(-3).join(" ");
    throw new ValidationError(`${bin} failed${detail ? `: ${detail}` : ""}`);
  }
}

/** Like runTool but returns trimmed stdout (probes/inspection). */
async function runToolCapture(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(path.join(pgBinDir(), exeName(bin)), args, {
      env: pgEnv(),
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr ?? e.message ?? "").trim().split("\n").slice(-3).join(" ");
    throw new ValidationError(`${bin} failed${detail ? `: ${detail}` : ""}`);
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function roleOf(user: BackupActor): string[] {
  return (user as { roleCodes?: string[] }).roleCodes ?? [];
}

function resolveBackupFile(name: string): string {
  if (!SAFE_NAME.test(name)) throw new ValidationError("invalid backup file name");
  const full = path.join(backupDir(), name);
  // Path traversal is impossible with the name regex, but keep the belt-and-braces
  // containment check anyway.
  if (path.dirname(full) !== path.normalize(backupDir())) throw new ValidationError("invalid backup file name");
  return full;
}

/** Shape-check a user-chosen destination/source path (absolute *.dump). */
function assertSafeCustomPath(filePath: string, what: string): string {
  const full = path.resolve(filePath);
  if (!path.isAbsolute(full)) throw new ValidationError(`${what} must be an absolute path`);
  const base = path.basename(full);
  if (!SAFE_CUSTOM_NAME.test(base)) {
    throw new ValidationError(`${what} must be a *.dump file with a plain file name`);
  }
  return full;
}

export async function listBackups(): Promise<BackupFile[]> {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  const out: BackupFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!SAFE_NAME.test(name)) continue;
    const st = statSync(path.join(dir, name));
    if (!st.isFile()) continue;
    out.push({ name, sizeBytes: st.size, createdAt: st.mtime.toISOString(), destination: dir });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** pg_dump (custom format) of the whole application database. */
async function dumpToFile(file: string): Promise<void> {
  mkdirSync(path.dirname(file), { recursive: true });
  // Custom format → pg_restore can validate (`--list`) and restore it later.
  await runTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${file}`]);
  if (!existsSync(file) || statSync(file).size === 0) {
    throw new ValidationError("backup produced no output");
  }
}

/** Integrity validation: the archive must be fully readable. */
async function validateBackupIntegrity(file: string): Promise<void> {
  if (!existsSync(file)) throw new NotFoundError("backup not found");
  if (statSync(file).size === 0) throw new ValidationError("backup file is empty");
  await runTool("pg_restore", ["--list", file]);
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/**
 * Target-database guard: restoring is only ever allowed INTO the application's
 * own configured LOCAL PNK database — never an arbitrary/dev/temp database.
 * Loopback host + the app's `schema_migrations` signature must both hold.
 */
async function assertRestoreTarget(): Promise<void> {
  const host = (pgEnv().PGHOST ?? "").toLowerCase();
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  if (!loopback) {
    throw new ValidationError(
      "restore refused: the configured database is not this machine's local PNK PostgreSQL database",
    );
  }
  try {
    const out = await runToolCapture("psql", ["-tAc", "select count(*) from schema_migrations"]);
    if (!/^\d+$/.test(out.trim())) throw new Error("unexpected probe output");
  } catch {
    throw new ValidationError(
      "restore refused: the configured database does not look like the PNK application database",
    );
  }
}

/** Post-restore verification that the restored database is in place. */
async function verifyRestoredDatabase(): Promise<void> {
  await assertRestoreTarget();
}

/**
 * Create and audit a full backup; returns its catalog entry.
 *
 * `target.filePath` (service-internal / token-resolved only) writes the
 * archive to a user-chosen location with the SAME pg_dump pipeline,
 * integrity validation, metadata and audit as the default destination. A
 * failed write/validation is audited as BACKUP_FAILED and NEVER reported as a
 * successful backup.
 */
export async function createBackup(
  user: BackupActor,
  label = "pnk-backup",
  target?: { filePath?: string; pickToken?: string },
): Promise<BackupFile> {
  let file: string;
  if (target?.pickToken) {
    const picked = resolvePickToken(target.pickToken, user, "destination");
    file = assertSafeCustomPath(picked, "backup destination");
  } else if (target?.filePath) {
    file = assertSafeCustomPath(target.filePath, "backup destination");
  } else {
    mkdirSync(backupDir(), { recursive: true });
    file = path.join(backupDir(), `${label}-${timestamp()}.dump`);
  }
  const destination = path.dirname(file);
  const name = path.basename(file);

  try {
    // Custom destinations must already exist and be real directories — the
    // dialog chose one; a vanished/invalid location is a clear error, not a
    // silent mkdir somewhere unintended. Checked INSIDE the try so the
    // failure is audited like any other failed backup.
    if (target) {
      const st = existsSync(destination) ? statSync(destination) : null;
      if (!st?.isDirectory()) {
        throw new ValidationError(`backup destination is not an accessible folder: ${destination}`);
      }
    }
    await dumpToFile(file);
    await validateBackupIntegrity(file);
    const st = statSync(file);
    const entry: BackupFile = { name, sizeBytes: st.size, createdAt: st.mtime.toISOString(), destination };
    await audit({
      user,
      action: "CREATED_BACKUP",
      entityType: "BACKUP",
      // audit_logs.entity_id is a uuid — the file name lives in the payload.
      entityId: null,
      newValue: {
        name,
        sizeBytes: st.size,
        destination,
        validation: "pg_restore --list OK",
        role: roleOf(user),
      },
      reason: `destination=${destination}`,
    });
    consumePickToken(target?.pickToken); // consumed on success only
    return entry;
  } catch (err) {
    // Never leave a misleading successful record for a failed operation.
    await audit({
      user,
      action: "BACKUP_FAILED",
      entityType: "BACKUP",
      entityId: null,
      newValue: { name, destination, error: err instanceof Error ? err.message : "unknown error", role: roleOf(user) },
      reason: `destination=${destination}`,
    }).catch(() => undefined);
    throw err;
  }
}

/**
 * Read-only inspection of a backup file (possibly untrusted, possibly from
 * outside the default backups folder). NEVER throws for bad content — a
 * `.dump` extension grants no trust: the PGDMP header and `pg_restore --list`
 * must both pass for `valid` to be true.
 */
export async function inspectBackupFile(filePath: string): Promise<BackupFileInspect> {
  const file = assertSafeCustomPath(filePath, "backup file");
  const base: BackupFileInspect = {
    name: path.basename(file),
    path: file,
    sizeBytes: 0,
    modifiedAt: "",
    sha256: "",
    valid: false,
    entries: null,
    error: null,
  };
  if (!existsSync(file)) return { ...base, error: "file not found" };
  const st = statSync(file);
  if (!st.isFile()) return { ...base, error: "not a regular file" };
  base.sizeBytes = st.size;
  base.modifiedAt = st.mtime.toISOString();
  if (st.size === 0) return { ...base, error: "backup file is empty" };

  try {
    base.sha256 = await sha256File(file);
  } catch {
    base.error = "file could not be read";
    return base;
  }

  // Untrusted input: header check first (a .dump extension grants no trust),
  // then the real pg_dump-format proof via pg_restore.
  let head = "";
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(5);
    try {
      readSync(fd, buf, 0, 5, 0);
    } finally {
      closeSync(fd);
    }
    head = buf.toString("latin1");
  } catch {
    base.error = "file could not be read";
    return base;
  }
  if (head !== "PGDMP") {
    base.error = "not a PostgreSQL custom-format backup (PGDMP header missing)";
    return base;
  }

  try {
    const toc = await runToolCapture("pg_restore", ["--list", file]);
    base.entries = toc.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    base.valid = true;
  } catch (err) {
    base.error = err instanceof Error ? err.message : "pg_restore could not read the archive";
  }
  return base;
}

/**
 * Restore a backup from the DEFAULT backups folder — see the module docblock
 * for the guards. The typed `confirm` must equal the backup file name exactly.
 */
export async function restoreBackup(
  user: BackupActor,
  opts: { filename: string; confirm: string },
): Promise<RestoreResult> {
  const file = resolveBackupFile(opts.filename);
  // Guard 2 — strong confirm: the operator types the file name itself.
  if (opts.confirm !== opts.filename) {
    throw new ValidationError("restore confirmation must exactly match the backup file name");
  }
  return performRestore(user, file, opts.filename, "default");
}

/**
 * Restore a backup the operator picked from ANOTHER local location (native
 * "Open" dialog). The file is untrusted until validated — the same integrity
 * validation, strong confirm, safety backup, target guard and audit run as
 * for a default-folder backup. The picked file is never copied, moved or
 * deleted.
 */
export async function restoreFromFile(
  user: BackupActor,
  opts: { filePath?: string; pickToken?: string; confirm: string },
): Promise<RestoreResult> {
  let picked: string;
  if (opts.pickToken) {
    picked = resolvePickToken(opts.pickToken, user, "file");
  } else if (opts.filePath) {
    picked = opts.filePath;
  } else {
    throw new ValidationError("no backup file was selected");
  }
  const file = assertSafeCustomPath(picked, "backup file");
  const name = path.basename(file);
  // Guard 2 — strong confirm: the operator types the file name itself.
  if (opts.confirm !== name) {
    throw new ValidationError("restore confirmation must exactly match the backup file name");
  }
  const result = await performRestore(user, file, name, "external");
  consumePickToken(opts.pickToken); // consumed on success only
  return result;
}

/** The shared, fully-guarded restore pipeline (default and external alike). */
async function performRestore(
  user: BackupActor,
  file: string,
  label: string,
  source: "default" | "external",
): Promise<RestoreResult> {
  try {
    // Guard 5 — the target must be the app's own local PNK database.
    await assertRestoreTarget();

    // Guard 3 — integrity validation BEFORE anything else touches the database.
    await validateBackupIntegrity(file);

    // Guard 4 — safety backup of the CURRENT database first.
    const safety = await createBackup(user, "pre-restore");

    // Destructive step: drop-and-recreate every object contained in the archive.
    await runTool("pg_restore", [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      `--dbname=${pgEnv().PGDATABASE}`,
      file,
    ]);

    // Post-restore verification + Drizzle pool reinitialization: pooled
    // connections are stale after the database was replaced.
    await verifyRestoredDatabase();
    await closeDbClient();

    await audit({
      user,
      action: "RESTORED_BACKUP",
      entityType: "BACKUP",
      entityId: null,
      reason: `restored ${source} backup ${label} (safety backup ${safety.name})`,
      newValue: {
        restored: label,
        source,
        sourcePath: source === "external" ? file : undefined,
        targetDatabase: pgEnv().PGDATABASE,
        validation: "pg_restore --list OK",
        safetyBackup: safety.name,
        role: roleOf(user),
      },
    });

    scheduleAppRestart();

    return {
      restored: label,
      safetyBackup: safety.name,
      restartRequired: true,
      source,
      targetDatabase: pgEnv().PGDATABASE,
    };
  } catch (err) {
    // Restore failures are audited with their stage/details (#5/#9).
    await audit({
      user,
      action: "RESTORE_FAILED",
      entityType: "BACKUP",
      entityId: null,
      newValue: {
        restored: label,
        source,
        sourcePath: source === "external" ? file : undefined,
        targetDatabase: (() => {
          try {
            return pgEnv().PGDATABASE;
          } catch {
            return null;
          }
        })(),
        error: err instanceof Error ? err.message : "unknown error",
        role: roleOf(user),
      },
      reason: `restore failed for ${label}`,
    }).catch(() => undefined);
    throw err;
  }
}

/* ---------------------------------------------------------------- */
/* Native picker + single-use pick tokens. The browser only ever     */
/* references a token — never a raw filesystem path.                  */
/* ---------------------------------------------------------------- */

interface PickToken {
  value: string;
  path: string;
  userId: string;
  kind: "destination" | "file";
  expires: number;
}

// Token semantics: a token maps to exactly ONE picked path and is bound to the
// user + operation kind. It is consumed only when the operation SUCCEEDS — a
// failed attempt (mistyped confirmation, unwritable destination) stays
// retryable within the TTL instead of punishing the user with "expired".

const pickTokens = new Map<string, PickToken>();
const PICK_TTL_MS = 15 * 60 * 1000;

async function issuePickToken(
  userId: string,
  kind: "destination" | "file",
  picked: string,
): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  const value = randomBytes(24).toString("hex");
  const now = Date.now();
  for (const [k, v] of pickTokens) if (v.expires < now) pickTokens.delete(k);
  pickTokens.set(value, { value, path: picked, userId, kind, expires: now + PICK_TTL_MS });
  return value;
}

function resolvePickToken(token: string, user: BackupActor, kind: "destination" | "file"): string {
  const entry = pickTokens.get(token);
  if (!entry || entry.expires < Date.now()) {
    pickTokens.delete(token);
    throw new ValidationError("the file selection has expired — please choose again");
  }
  if (entry.userId !== user.userId || entry.kind !== kind) {
    throw new ValidationError("the file selection is not valid for this operation");
  }
  return entry.path;
}

/** Consume after SUCCESS — the picked path has been acted upon. */
function consumePickToken(token: string | undefined): void {
  if (token) pickTokens.delete(token);
}

export interface PickDestinationResult {
  cancelled: boolean;
  token?: string;
  fileName?: string;
  directory?: string;
  displayPath?: string;
}

/** Native "Save As" dialog → tokenized backup destination. */
export async function pickBackupDestination(user: BackupActor): Promise<PickDestinationResult> {
  mkdirSync(backupDir(), { recursive: true });
  const { path: picked } = await pickSavePath({
    defaultFileName: `pnk-backup-${timestamp()}.dump`,
    initialDir: backupDir(),
  });
  if (!picked) return { cancelled: true };
  const full = assertSafeCustomPath(picked, "backup destination");
  const token = await issuePickToken(user.userId, "destination", full);
  return {
    cancelled: false,
    token,
    fileName: path.basename(full),
    directory: path.dirname(full),
    displayPath: full,
  };
}

export interface PickRestoreFileResult {
  cancelled: boolean;
  token?: string;
  inspect?: BackupFileInspect;
}

/** Native "Open" dialog → tokenized, immediately-inspected backup file. */
export async function pickRestoreFile(user: BackupActor): Promise<PickRestoreFileResult> {
  const { path: picked } = await pickOpenFile({ initialDir: backupDir() });
  if (!picked) return { cancelled: true };
  const full = assertSafeCustomPath(picked, "backup file");
  const inspect = await inspectBackupFile(full);
  const token = await issuePickToken(user.userId, "file", full);
  return { cancelled: false, token, inspect };
}

/**
 * "App restart after restore": in a packaged run (the launcher's control pipe is
 * present) schedule a graceful exit so the launcher's next `start` brings the
 * application back on the restored database. Dev/test never self-terminates —
 * the caller is told `restartRequired` instead.
 */
function scheduleAppRestart(): void {
  if (!process.env.PNK_APP_CONTROL_PIPE) return;
  setTimeout(() => {
    try {
      writeFileSync(path.join(backupDir(), ".restart-required"), new Date().toISOString());
    } catch {
      /* marker is best-effort only */
    }
    process.exit(0);
  }, 3000).unref();
}
