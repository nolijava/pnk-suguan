/**
 * Runtime configuration for the packaged application.
 *
 * Secrets live ONLY in DATA_DIR/.env, are generated on first run with the CSPRNG,
 * and are never written to a log, bundled with the program, or committed. The
 * program payload ships with no credentials at all.
 *
 * Ports are chosen deterministically: a documented default is preferred, and if
 * it is occupied the launcher scans upward and PERSISTS the choice to
 * DATA_DIR/config.json so every later launch reuses the same ports.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { paths } from "./paths.mjs";

export const DEFAULT_APP_PORT = 3210;
export const DEFAULT_PG_PORT = 55432;
/** The app binds loopback only — never the LAN. */
export const BIND_HOST = "127.0.0.1";

const PORT_SCAN_LIMIT = 50;

/** Keys an operator may set in DATA_DIR/.env and have forwarded to the app. */
const PASSTHROUGH_KEYS = [
  "INITIAL_ADMIN_EMAIL",
  "SCHEDULING_GO_LIVE",
  "PNK_SMTP_URL",
  "PNK_SMTP_FROM",
  "PNK_SMTP_HOST",
  "PNK_SMTP_PORT",
  "PNK_SMTP_SECURE",
  "PNK_SMTP_USER",
  "PNK_SMTP_PASS",
  "PNK_SCHEDULE_CORRECTION_TTL_MS",
  "PNK_AVAILABILITY_CORRECTION_TTL_MS",
];

function urlSafeSecret(bytes) {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Generate a one-time administrator password that already satisfies the
 * application's policy (>=10 chars, upper, lower, digit, symbol), so
 * bootstrapInitialAdmin() accepts it instead of rejecting it for strength.
 * Guarantees one of each required class, then CSPRNG-shuffles.
 */
export function generateAdminPassword(length = 20) {
  const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const LOWER = "abcdefghjkmnpqrstuvwxyz";
  const DIGIT = "23456789";
  const SYMBOL = "!@#$%^&*_-+=";
  const ALL = UPPER + LOWER + DIGIT + SYMBOL;
  const pick = (set) => set[randomBytes(1)[0] % set.length];

  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < length) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Minimal dotenv parser — the launcher must not depend on node_modules. */
export function readEnvFile(file = paths.envFile) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function writeEnvFile(env, file = paths.envFile) {
  const body =
    [
      "# PNK Suguan System — generated runtime configuration.",
      "#",
      "# SECURITY: this file holds live credentials. It is written with the",
      "# CSPRNG on first run, is specific to THIS machine, and must never be",
      "# copied into the program package, committed, or shared.",
      "#",
      "# Edit only the optional keys (SMTP for password-reset email). The",
      "# generated secrets can be rotated by deleting the line and restarting,",
      "# but rotating PNK_DB_PASSWORD alone will break the existing cluster.",
      "",
      ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      "",
    ].join("\n");

  writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows ignores POSIX modes; the file is already user-scoped in LOCALAPPDATA */
  }
}

/**
 * Load the secret store, creating it on first run.
 * Returns { env, created } — `env` includes the generated secrets but is only
 * ever used to build a child process environment, never logged.
 */
export function ensureSecrets() {
  const existing = readEnvFile();
  if (existing.PNK_DB_PASSWORD && existing.PNK_SUPER_ADMIN_SECRET && existing.PNK_OTP_PEPPER) {
    return { env: existing, created: false };
  }

  const env = {
    // 32 bytes -> 43 url-safe chars, safe to embed in a connection string.
    PNK_DB_PASSWORD: existing.PNK_DB_PASSWORD || urlSafeSecret(32),
    // Server-side secret for the SUPER_ADMIN PUBLISHED unlock (never the DB password).
    PNK_SUPER_ADMIN_SECRET: existing.PNK_SUPER_ADMIN_SECRET || urlSafeSecret(32),
    // Pepper for the one-way OTP hash; the recovery flow fails closed without it.
    PNK_OTP_PEPPER: existing.PNK_OTP_PEPPER || urlSafeSecret(32),
    // Local identity for the one-time initial administrator (a value, not an
    // authorization rule — RBAC comes from roles).
    INITIAL_ADMIN_EMAIL: existing.INITIAL_ADMIN_EMAIL || "admin@pnk.local",
    // Optional operator keys are preserved verbatim if already present.
    ...Object.fromEntries(
      PASSTHROUGH_KEYS.filter((k) => existing[k] !== undefined).map((k) => [k, existing[k]]),
    ),
  };

  writeEnvFile(env);
  return { env, created: true };
}

export function readConfig() {
  if (!existsSync(paths.configFile)) return {};
  try {
    return JSON.parse(readFileSync(paths.configFile, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  writeFileSync(paths.configFile, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

export function isPortFree(port, host = BIND_HOST) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function pickPort(preferred, avoid = []) {
  for (let p = preferred; p < preferred + PORT_SCAN_LIMIT; p++) {
    if (avoid.includes(p)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return p;
  }
  throw new Error(
    `no free port in ${preferred}-${preferred + PORT_SCAN_LIMIT - 1}. ` +
      "Free a port or edit config.json in the data folder.",
  );
}

/**
 * Resolve the ports for this run, persisting any fallback so subsequent launches
 * are stable. Preferred ports win whenever they are free.
 */
export async function resolvePorts() {
  const cfg = readConfig();

  // A still-free persisted port is reused; otherwise re-pick from the default.
  let pgPort =
    cfg.pgPort && (await isPortFree(cfg.pgPort)) ? cfg.pgPort : await pickPort(DEFAULT_PG_PORT);
  let appPort =
    cfg.appPort && (await isPortFree(cfg.appPort)) && cfg.appPort !== pgPort
      ? cfg.appPort
      : await pickPort(DEFAULT_APP_PORT, [pgPort]);

  const changed = cfg.pgPort !== pgPort || cfg.appPort !== appPort;
  if (changed) writeConfig({ ...cfg, pgPort, appPort });

  return { pgPort, appPort, reused: !changed && cfg.pgPort !== undefined };
}

/** The database the application uses inside the bundled cluster. */
export const DB_NAME = "pnk";
export const DB_USER = "postgres";

export function databaseUrl(env, pgPort) {
  return `postgresql://${DB_USER}:${encodeURIComponent(env.PNK_DB_PASSWORD)}@${BIND_HOST}:${pgPort}/${DB_NAME}`;
}

/**
 * Environment for the Next.js server. Production mode is mandatory here: it
 * enables the Secure session cookie and the strict CSP (no unsafe-eval), and it
 * hard-disables the development-only reset-code echo.
 */
export function appEnv(env, { pgPort, appPort }) {
  const out = {
    NODE_ENV: "production",
    DATABASE_URL: databaseUrl(env, pgPort),
    PNK_SUPER_ADMIN_SECRET: env.PNK_SUPER_ADMIN_SECRET,
    PNK_OTP_PEPPER: env.PNK_OTP_PEPPER,
    PORT: String(appPort),
    HOSTNAME: BIND_HOST,
  };
  for (const key of PASSTHROUGH_KEYS) {
    if (env[key] !== undefined && env[key] !== "") out[key] = env[key];
  }
  // Never inherit a development echo of reset codes in a packaged build.
  delete out.PNK_PASSWORD_RESET_DEV_ECHO;
  return out;
}
