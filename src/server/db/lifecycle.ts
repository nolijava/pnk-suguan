import { getDbClient } from "./client";

/** Close the pooled connection (for CLI scripts). */
export async function closeDb(): Promise<void> {
  await getDbClient().end();
}
