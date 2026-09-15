#!/usr/bin/env node
/**
 * Writes a starter .env.local with LOCAL DEV values only.
 * Never contains real secrets; edit .env.local manually afterwards.
 * Usage: node scripts/write-env.mjs
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const envLocalPath = path.join(ROOT, ".env.local");

if (existsSync(envLocalPath) && !process.argv.includes("--force")) {
  console.log("[write-env] .env.local already exists — leaving it untouched.");
  process.exit(0);
}

const content = `# LOCAL DEVELOPMENT ONLY — this file is gitignored and must never be committed.
# Real secrets go here or in your secret store; never in the repository.

# Dev database (portable cluster managed by scripts/portable-pg.mjs)
DATABASE_URL=postgresql://pnk:pnk@127.0.0.1:5433/pnk

# Test database (used by vitest integration suites)
PNK_TEST_DATABASE_URL=postgresql://pnk:pnk@127.0.0.1:5434/pnk_test

# ── Initial Administrator bootstrap (ONE-TIME; see docs/setup.md) ────────────
# Password must come from a secret you set yourself — never committed anywhere.
INITIAL_ADMIN_EMAIL=nolijava26@gmail.com
# INITIAL_ADMIN_PASSWORD=<set this yourself in .env.local only>
`;

writeFileSync(envLocalPath, content);
console.log("[write-env] wrote .env.local (local dev values; add your own secrets).");
