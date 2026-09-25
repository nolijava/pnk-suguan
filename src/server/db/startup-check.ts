/**
 * Post-release hardening — advisory startup database check.
 *
 * Catches the "the config says one database, the app runs against another"
 * class of drift (exactly what bit the Backup update: .env.local pointed at a
 * dead cluster while the running app used another one). On startup the app:
 *   1. resolves the URL it will ACTUALLY use (same rule as db/client.ts),
 *   2. compares it against the config file (.env.local / .env),
 *   3. probes the live connection and asks PostgreSQL itself which database,
 *      address and port it is really talking to,
 * then prints one clear line — or a WARNING for every disagreement.
 *
 * Purely advisory: it never throws, never blocks startup, and NEVER logs
 * database passwords (every URL is redacted first). The comparison logic is
 * pure (compareConfiguration) so it is unit-tested without any database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import postgres from "postgres";

export interface DatabaseTarget {
  database: string;
  host: string;
  /** Port as written in the URL ("" = omitted, i.e. PostgreSQL's 5432). */
  port: string;
}

export interface EffectiveUrl {
  url: string | null;
  source: "DATABASE_URL" | "PNK_TEST_DATABASE_URL" | "none";
}

/** What PostgreSQL itself reported about the connection we actually opened. */
export interface ActualConnection {
  database: string;
  host: string | null;
  port: number | null;
}

export interface StartupCheckReport {
  /** Redacted — safe to print. */
  effectiveUrl: string;
  source: EffectiveUrl["source"];
  /** Which config file was compared (null = none found). */
  configFile: string | null;
  /** Redacted connection description for the log line. */
  connectedTo: string | null;
  warnings: string[];
  ok: boolean;
}

/** Mask the password in a connection URL before it goes anywhere near a log. */
export function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "(unparseable database URL — hidden)";
  }
}

export function parseDatabaseTarget(url: string): DatabaseTarget | null {
  try {
    const u = new URL(url);
    return {
      database: decodeURIComponent(u.pathname.replace(/^\//, "")),
      host: u.hostname,
      port: u.port,
    };
  } catch {
    return null;
  }
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0:0:0:0:0:0:0:1";
}

/** Same resolution rule as db/client.ts: DATABASE_URL, else the test cluster. */
export function resolveEffectiveUrl(
  env: Record<string, string | undefined> = process.env,
): EffectiveUrl {
  if (env.DATABASE_URL) return { url: env.DATABASE_URL, source: "DATABASE_URL" };
  if (env.PNK_TEST_DATABASE_URL) return { url: env.PNK_TEST_DATABASE_URL, source: "PNK_TEST_DATABASE_URL" };
  return { url: null, source: "none" };
}

/**
 * The configured URL from the env files (Next.js precedence: .env.local
 * overrides .env). `root` is injectable for tests.
 */
export function readConfigFileUrl(root: string = process.cwd()): { file: string; url: string | null } | null {
  let found: { file: string; url: string | null } | null = null;
  for (const name of [".env", ".env.local"]) {
    try {
      const parsed = parseDotenv(readFileSync(path.join(root, name)));
      if ("DATABASE_URL" in parsed) found = { file: name, url: parsed.DATABASE_URL || null };
    } catch {
      // Missing or unreadable file — nothing to compare against.
    }
  }
  return found;
}

/** Pure comparison of configured vs actual — the unit-tested heart. */
export function compareConfiguration(input: {
  effective: EffectiveUrl;
  configFilePath: string | null;
  configFileUrl: string | null;
  /** null = the probe could not run (unreachable / error). */
  actual: ActualConnection | null;
  probeError: string | null;
}): StartupCheckReport {
  const warnings: string[] = [];
  const { effective, configFilePath, configFileUrl, actual, probeError } = input;
  const redacted = effective.url ? redactDatabaseUrl(effective.url) : "(unset)";
  const target = effective.url ? parseDatabaseTarget(effective.url) : null;

  if (!effective.url) {
    warnings.push("DATABASE_URL is not set — the application has no database to connect to.");
  } else if (effective.source === "PNK_TEST_DATABASE_URL") {
    warnings.push(
      `the app is running against the TEST cluster via PNK_TEST_DATABASE_URL (${redacted}) — DATABASE_URL is unset.`,
    );
  }

  // 1. Config file vs the value the app is really using (env-override drift).
  if (effective.url && configFileUrl && configFilePath) {
    const cfgTarget = parseDatabaseTarget(configFileUrl);
    const sameTarget =
      cfgTarget && target
        ? cfgTarget.database === target.database &&
          cfgTarget.host === target.host &&
          cfgTarget.port === target.port
        : cfgTarget === null && target === null;
    if (!sameTarget) {
      warnings.push(
        `config drift: ${configFilePath} points at ${redactDatabaseUrl(configFileUrl)} ` +
          `but the app is using ${redacted} (environment override) — update ${configFilePath} to match.`,
      );
    }
  }

  // 2. Reachability / identity of the connection actually opened.
  if (probeError) {
    warnings.push(`the configured database ${redacted} is unreachable: ${probeError}`);
  } else if (actual && target) {
    if (actual.database !== target.database) {
      warnings.push(
        `connected to database "${actual.database}" but ${effective.source} specifies "${target.database}".`,
      );
    }
    const expectedPort = target.port ? Number(target.port) : 5432;
    if (actual.port !== null && actual.port !== expectedPort) {
      warnings.push(`connected to port ${actual.port} but ${effective.source} specifies ${expectedPort}.`);
    }
    if (actual.host && !isLoopback(actual.host) && !isLoopback(target.host) && actual.host !== target.host) {
      warnings.push(`connected to host ${actual.host} but ${effective.source} specifies ${target.host}.`);
    }
  }

  const connectedTo =
    actual && effective.url
      ? `${actual.database} @ ${actual.host ?? "local socket"}${actual.port !== null ? `:${actual.port}` : ""}`
      : null;
  return {
    effectiveUrl: redacted,
    source: effective.source,
    configFile: configFilePath,
    connectedTo,
    warnings,
    ok: warnings.length === 0,
  };
}

/** Ask PostgreSQL what database/connection we actually got. Never throws. */
async function probeActual(url: string): Promise<{ actual: ActualConnection | null; error: string | null }> {
  const sql = postgres(url, { max: 1, connect_timeout: 3, prepare: false });
  try {
    const rows = await sql<
      { database: string; host: string | null; port: number | null }[]
    >`select current_database() as database, host(inet_server_addr()) as host, inet_server_port() as port`;
    const row = rows[0];
    if (!row) return { actual: null, error: "the database returned no identity row" };
    return { actual: { database: row.database, host: row.host, port: row.port }, error: null };
  } catch (err) {
    return { actual: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

/**
 * The startup entry point: prints `[db-check] …` lines and returns the report.
 * Advisory only — wrapped so it can never break application startup.
 */
export async function runDatabaseStartupCheck(): Promise<StartupCheckReport> {
  try {
    const effective = resolveEffectiveUrl();
    const cfg = readConfigFileUrl();
    let actual: ActualConnection | null = null;
    let probeError: string | null = null;
    if (effective.url) {
      ({ actual, error: probeError } = await probeActual(effective.url));
    }
    const report = compareConfiguration({
      effective,
      configFilePath: cfg?.file ?? null,
      configFileUrl: cfg?.url ?? null,
      actual,
      probeError,
    });
    if (report.ok) {
      console.info(
        `[db-check] database OK — connected to ${report.connectedTo ?? "(unknown)"} ` +
          `(via ${report.source}${report.configFile ? `; matches ${report.configFile}` : ""}).`,
      );
    } else {
      for (const w of report.warnings) console.warn(`[db-check] WARNING: ${w}`);
    }
    return report;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[db-check] check skipped: ${msg}`);
    return {
      effectiveUrl: "(unset)",
      source: "none",
      configFile: null,
      connectedTo: null,
      warnings: [`check skipped: ${msg}`],
      ok: false,
    };
  }
}
