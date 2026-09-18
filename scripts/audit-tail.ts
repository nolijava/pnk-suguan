import postgres from "postgres";

/** One-off diagnostic: newest audit rows (optionally filtered by entityType). */
async function main(): Promise<void> {
  const urlArg = process.argv.find((a) => a.startsWith("postgres"));
  const url = urlArg ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("usage: tsx scripts/audit-tail.ts [database-url]");
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, prepare: false });
  const rows = await sql`
    SELECT a.action, a.entity_type, a.entity_id, a.old_value, a.new_value, a.reason, u.email AS actor, a.created_at
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.entity_type = 'user'
    ORDER BY a.created_at DESC
    LIMIT 12`;
  for (const r of rows) {
    console.log(JSON.stringify(r));
  }
  await sql.end();
}

void main();
