/**
 * Post-release hardening — startup database check (pure logic): config-file
 * drift detection, reachability/identity mismatches, and the hard rule that
 * database passwords never reach a log.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareConfiguration,
  parseDatabaseTarget,
  readConfigFileUrl,
  redactDatabaseUrl,
  resolveEffectiveUrl,
  type ActualConnection,
} from "@/server/db/startup-check";

const LIVE = "postgresql://pnk:secretpw@127.0.0.1:5434/pnk_preview";

function actual(over: Partial<ActualConnection> = {}): ActualConnection {
  return { database: "pnk_preview", host: "127.0.0.1", port: 5434, ...over };
}

describe("redaction — passwords never reach a log", () => {
  it("masks the password but keeps host/database visible", () => {
    const r = redactDatabaseUrl(LIVE);
    expect(r).not.toContain("secretpw");
    expect(r).toContain("127.0.0.1:5434");
    expect(r).toContain("pnk_preview");
  });

  it("hides unparseable URLs instead of echoing them", () => {
    expect(redactDatabaseUrl("not a url")).not.toContain("not a url");
  });

  it("the whole report is safe to print (no password anywhere)", () => {
    const report = compareConfiguration({
      effective: { url: LIVE, source: "DATABASE_URL" },
      configFilePath: ".env.local",
      configFileUrl: "postgresql://pnk:otherpw@127.0.0.1:5433/pnk",
      actual: null,
      probeError: "connect ECONNREFUSED",
    });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("secretpw");
    expect(JSON.stringify(report)).not.toContain("otherpw");
  });
});

describe("effective URL resolution (same rule as db/client.ts)", () => {
  it("prefers DATABASE_URL, falls back to the test cluster, else none", () => {
    expect(resolveEffectiveUrl({ DATABASE_URL: "a", PNK_TEST_DATABASE_URL: "b" })).toEqual({
      url: "a",
      source: "DATABASE_URL",
    });
    expect(resolveEffectiveUrl({ PNK_TEST_DATABASE_URL: "b" })).toEqual({
      url: "b",
      source: "PNK_TEST_DATABASE_URL",
    });
    expect(resolveEffectiveUrl({})).toEqual({ url: null, source: "none" });
  });
});

describe("compareConfiguration — drift and mismatch warnings", () => {
  it("clean: config file and live connection agree", () => {
    const report = compareConfiguration({
      effective: { url: LIVE, source: "DATABASE_URL" },
      configFilePath: ".env.local",
      configFileUrl: LIVE,
      actual: actual(),
      probeError: null,
    });
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.connectedTo).toContain("pnk_preview");
  });

  it("warns when the env override points elsewhere than the config file (the stale-.env case)", () => {
    const report = compareConfiguration({
      effective: { url: LIVE, source: "DATABASE_URL" },
      configFilePath: ".env.local",
      configFileUrl: "postgresql://pnk:pnk@127.0.0.1:5433/pnk",
      actual: actual(),
      probeError: null,
    });
    expect(report.ok).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/config drift: \.env\.local/);
    expect(report.warnings.join(" ")).toContain("5434/pnk_preview");
  });

  it("formatting-only URL differences with the same target are not drift", () => {
    const report = compareConfiguration({
      effective: { url: LIVE, source: "DATABASE_URL" },
      configFilePath: ".env.local",
      configFileUrl: "postgresql://pnk:rotatedpw@127.0.0.1:5434/pnk_preview",
      actual: actual(),
      probeError: null,
    });
    expect(report.ok).toBe(true);
  });

  it("warns when the configured database is unreachable", () => {
    const report = compareConfiguration({
      effective: { url: LIVE, source: "DATABASE_URL" },
      configFilePath: null,
      configFileUrl: null,
      actual: null,
      probeError: "connect ECONNREFUSED 127.0.0.1:5433",
    });
    expect(report.ok).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/unreachable.*ECONNREFUSED/);
  });

  it("warns when the connection lands on a different database or port than configured", () => {
    const dbMismatch = compareConfiguration({
      effective: { url: LIVE, source: "DATABASE_URL" },
      configFilePath: null,
      configFileUrl: null,
      actual: actual({ database: "pnk_test" }),
      probeError: null,
    });
    expect(dbMismatch.warnings.join(" ")).toMatch(/connected to database "pnk_test".*"pnk_preview"/);

    const portMismatch = compareConfiguration({
      effective: { url: LIVE, source: "DATABASE_URL" },
      configFilePath: null,
      configFileUrl: null,
      actual: actual({ port: 5433 }),
      probeError: null,
    });
    expect(portMismatch.warnings.join(" ")).toMatch(/port 5433.*5434/);
  });

  it("an omitted URL port means 5432, and loopback aliases are the same host", () => {
    const target = parseDatabaseTarget("postgresql://pnk:pnk@localhost/pnk_preview")!;
    expect(target.port).toBe("");
    const report = compareConfiguration({
      effective: { url: "postgresql://pnk:pnk@localhost/pnk_preview", source: "DATABASE_URL" },
      configFilePath: null,
      configFileUrl: null,
      actual: actual({ host: "127.0.0.1", port: 5432 }),
      probeError: null,
    });
    // port 5432 = the default for a portless URL; localhost ≡ 127.0.0.1.
    expect(report.ok).toBe(true);
  });

  it("warns when no DATABASE_URL exists at all, and when running on the test cluster", () => {
    const none = compareConfiguration({
      effective: { url: null, source: "none" },
      configFilePath: null,
      configFileUrl: null,
      actual: null,
      probeError: null,
    });
    expect(none.warnings.join(" ")).toMatch(/DATABASE_URL is not set/);

    const testCluster = compareConfiguration({
      effective: { url: "postgresql://pnk:pnk@127.0.0.1:5434/pnk_test", source: "PNK_TEST_DATABASE_URL" },
      configFilePath: null,
      configFileUrl: null,
      actual: actual({ database: "pnk_test" }),
      probeError: null,
    });
    expect(testCluster.warnings.join(" ")).toMatch(/TEST cluster/);
  });
});

describe("readConfigFileUrl — Next.js env-file precedence", () => {
  it("reads .env.local over .env, and reports which file it compared", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pnk-env-test-"));
    try {
      writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgresql://u:p@db-one:5432/a\nOTHER=1\n");
      expect(readConfigFileUrl(dir)).toEqual({ file: ".env", url: "postgresql://u:p@db-one:5432/a" });
      writeFileSync(path.join(dir, ".env.local"), "DATABASE_URL=postgresql://u:p@db-two:5433/b\n");
      expect(readConfigFileUrl(dir)).toEqual({ file: ".env.local", url: "postgresql://u:p@db-two:5433/b" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no env file configures a database", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pnk-env-test-"));
    try {
      writeFileSync(path.join(dir, ".env"), "OTHER=1\n");
      expect(readConfigFileUrl(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
