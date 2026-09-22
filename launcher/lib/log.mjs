/**
 * Launcher logging: console (so a double-click shows progress) plus an append-only
 * file under DATA_DIR/logs.
 *
 * SECURITY: nothing here may ever receive a secret. Callers pass progress text
 * only — passwords, the unlock secret and the OTP pepper never reach a log line.
 * `redact()` exists as a belt-and-braces filter for anything interpolated.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024; // rotate at 2 MB, keep one previous file

let logFile = null;
let started = false;

export function initLog(filePath) {
  logFile = filePath;
  started = false;
}

function rotateIfNeeded() {
  try {
    if (!logFile) return;
    if (!existsSync(logFile)) return;
    if (statSync(logFile).size < MAX_LOG_BYTES) return;
    renameSync(logFile, `${logFile}.1`);
  } catch {
    /* rotation is best-effort — never let logging break startup */
  }
}

function write(stream, line) {
  try {
    if (logFile) {
      mkdirSync(path.dirname(logFile), { recursive: true });
      rotateIfNeeded();
      const at = new Date().toISOString();
      appendFileSync(logFile, `${at} ${line}\n`, "utf8");
    }
  } catch {
    /* best-effort */
  }
  if (stream === "err") console.error(line);
  else console.log(line);
}

/** Mask anything that looks like a credential before it can be written. */
export function redact(text) {
  if (typeof text !== "string") return text;
  return text
    // postgres://user:password@host  /  postgresql://...
    .replace(/(postgres(?:ql)?:\/\/[^:/@\s]+:)([^@\s]+)(@)/gi, "$1***$3")
    .replace(/(password=)([^\s&"']+)/gi, "$1***")
    .replace(/(PNK_SUPER_ADMIN_SECRET\s*[=:]\s*)(\S+)/gi, "$1***")
    .replace(/(PNK_OTP_PEPPER\s*[=:]\s*)(\S+)/gi, "$1***");
}

export const log = {
  banner(text) {
    started = true;
    const line = `\n${text}`;
    write("out", line);
  },
  step(text) {
    started = true;
    write("out", `  → ${redact(text)}`);
  },
  info(text) {
    write("out", `    ${redact(text)}`);
  },
  ok(text) {
    write("out", `  ✓ ${redact(text)}`);
  },
  warn(text) {
    write("err", `  ! ${redact(text)}`);
  },
  fail(text) {
    write("err", `  ✗ ${redact(text)}`);
  },
};
