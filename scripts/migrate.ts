/**
 * Migration runner — applies drizzle/*.sql files in filename order.
 * Records each applied migration in schema_migrations.
 * Usage: tsx scripts/migrate.ts [--database-url <url>]
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--database-url");
const DATABASE_URL =
  (urlIdx >= 0 ? args[urlIdx + 1] : undefined) ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[migrate] DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, prepare: false });

/** Split SQL into statements, respecting $$ dollar quotes and -- comments. */
function splitStatements(src: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < src.length; i++) {
    const two = src.slice(i, i + 2);
    if (inLineComment) {
      cur += src[i];
      if (src[i] === "\n") inLineComment = false;
      continue;
    }
    if (two === "--") {
      inLineComment = true;
      cur += two;
      i++;
      continue;
    }
    if (two === "$$") {
      inDollar = !inDollar;
      cur += two;
      i++;
      continue;
    }
    if (src[i] === ";" && !inDollar) {
      const s = cur.trim();
      if (s) out.push(s);
      cur = "";
      continue;
    }
    cur += src[i];
  }
  const last = cur.trim();
  if (last) out.push(last);
  return out;
}

async function main() {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

  const dir = path.resolve(import.meta.dirname, "..", "drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const applied = await sql`SELECT 1 FROM schema_migrations WHERE name = ${file}`;
    if (applied.length > 0) {
      console.log(`[migrate] = ${file} (already applied)`);
      continue;
    }
    const content = readFileSync(path.join(dir, file), "utf8");
    const statements = splitStatements(content
      .split("--> statement-breakpoint")
      .join("\n"));
    try {
      await sql.begin(async (tx) => {
        for (const stmt of statements) {
          await tx.unsafe(stmt);
          console.log(`[migrate]   ok: ${stmt.slice(0, 72).replace(/\n/g, " ")}…`);
        }
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      console.log(`[migrate] ✓ ${file}`);
    } catch (err) {
      console.error(`[migrate] ✗ ${file}: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  console.log("[migrate] done");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
