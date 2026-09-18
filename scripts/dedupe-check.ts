import postgres from "postgres";

/**
 * One-off diagnostic for duplicate user_roles grants (migration 0006 guard).
 * `--fix` deletes duplicates, keeping the earliest grant (min id) per pair.
 */
async function main(): Promise<void> {
  const fix = process.argv.includes("--fix");
  const urlArg = process.argv.find((a) => a.startsWith("postgres"));
  const url = urlArg ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("usage: tsx scripts/dedupe-check.ts [--fix] <database-url>");
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, prepare: false });
  const rows = await sql`
    SELECT ur.user_id, u.email, r.code, count(*)::int AS n
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN users u ON u.id = ur.user_id
    GROUP BY ur.user_id, u.email, r.code
    HAVING count(*) > 1`;
  if (rows.length === 0) {
    console.log("no duplicates");
    await sql.end();
    return;
  }
  console.log(JSON.stringify(rows, null, 2));
  if (fix) {
    // user_roles has no surrogate id column — dedupe by physical row identity,
    // keeping the first-inserted row (min ctid) per (user_id, role_id).
    const deleted = await sql`
      DELETE FROM user_roles ur
      USING user_roles keep
      WHERE ur.user_id = keep.user_id
        AND ur.role_id = keep.role_id
        AND ur.ctid > keep.ctid`;
    console.log(`deleted ${deleted.count} duplicate grant(s)`);
  }
  await sql.end();
}

void main();
