import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let client: postgres.Sql | undefined;

export function getDbClient(): postgres.Sql {
  if (!client) {
    // The app uses DATABASE_URL. PNK_TEST_DATABASE_URL applies only when
    // DATABASE_URL is unset (vitest contexts) — it must never silently point
    // the running app at the test cluster.
    const url = process.env.DATABASE_URL ?? process.env.PNK_TEST_DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    client = postgres(url, { max: 10, prepare: false });
  }
  return client;
}

export function getDb(): Database {
  return drizzle(getDbClient(), { schema });
}

/**
 * Drop the cached connection pool. Restore flow only: the database was
 * replaced underneath the app, so every pooled connection is stale — the next
 * getDb() call opens a fresh pool against the restored database.
 */
export async function closeDbClient(): Promise<void> {
  const c = client;
  client = undefined;
  if (c) await c.end({ timeout: 5 });
}

/** Run a unit of work; rolls back on throw. */
export async function withTransaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
  return (await getDb().transaction(async (tx) => fn(tx as unknown as Database))) as T;
}
