/**
 * One-time initial administrator bootstrap.
 * Reads INITIAL_ADMIN_EMAIL + INITIAL_ADMIN_PASSWORD (or *_FILE) from the
 * environment / .env.local. Idempotent: re-running never duplicates or overwrites.
 * Usage: tsx scripts/setup-admin.ts [--database-url <url>]
 */
import "dotenv/config";
import { bootstrapInitialAdmin } from "../src/server/auth/bootstrap";
import { closeDb } from "../src/server/db/lifecycle";

async function main() {
  try {
    const result = await bootstrapInitialAdmin();
    console.log(
      result.created
        ? `[setup-admin] created initial administrator: ${result.email} (must_change_password=true)`
        : `[setup-admin] administrator already exists: ${result.email} — left untouched`,
    );
  } finally {
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(`[setup-admin] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
