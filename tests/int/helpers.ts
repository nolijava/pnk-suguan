import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql as drizzleSql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { hashPassword } from "@/server/auth/password";

export const TEST_URL = process.env.PNK_TEST_DATABASE_URL ?? "postgresql://pnk:pnk@127.0.0.1:5434/pnk_test";

// Service-layer code resolves its pool lazily via DATABASE_URL (client.ts
// prefers DATABASE_URL, then PNK_TEST_DATABASE_URL). Default it in vitest
// contexts so suites are deterministic regardless of the invoking shell.
process.env.DATABASE_URL ??= process.env.PNK_TEST_DATABASE_URL ?? TEST_URL;

export const sql = postgres(TEST_URL, { max: 1, prepare: false });
export const db = drizzle(sql, { schema });

let adminId: string | undefined;
let superAdminId: string | undefined;

/** Per-test-file: truncate operational tables, create a fresh ADMIN user. */
export async function resetTestDb(): Promise<void> {
  await sql`TRUNCATE TABLE assignment_history, assignments, teacher_availability, notifications,
    dako_anniversary_notifications, audit_logs, sessions, password_reset_challenges,
    user_roles, teachers, dako, weeks, users RESTART IDENTITY CASCADE`;
  adminId = undefined;
  superAdminId = undefined;
}

export async function seedAdmin(): Promise<string> {
  if (adminId) return adminId;
  const passwordHash = await hashPassword("TestAdminPass1!");
  const inserted = await db
    .insert(schema.users)
    .values({ email: "admin@test.local", fullName: "Test Admin", passwordHash })
    .returning();
  const user = inserted[0]!;
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, "ADMIN"));
  await db.insert(schema.userRoles).values({ userId: user.id, roleId: roleRows[0]!.id });
  adminId = user.id;
  return user.id;
}

/**
 * A REAL super-admin user row. Needed (not a synthetic id) wherever the actor is
 * the GRANT HOLDER, because audit_logs.user_id has an FK to users.id — a
 * synthetic id would violate it as soon as an audit row is written.
 */
export async function seedSuperAdmin(): Promise<string> {
  if (superAdminId) return superAdminId;
  const passwordHash = await hashPassword("TestSuperPass1!");
  const inserted = await db
    .insert(schema.users)
    .values({ email: "super@test.local", fullName: "Test Super Admin", passwordHash })
    .returning();
  const user = inserted[0]!;
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, "SUPER_ADMIN"));
  await db.insert(schema.userRoles).values({ userId: user.id, roleId: roleRows[0]!.id });
  superAdminId = user.id;
  return user.id;
}

export async function seedScheduler(): Promise<string> {
  const passwordHash = await hashPassword("TestSchedPass1!");
  const inserted = await db
    .insert(schema.users)
    .values({ email: "sched@test.local", fullName: "Test Scheduler", passwordHash })
    .returning();
  const user = inserted[0]!;
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, "SCHEDULER"));
  await db.insert(schema.userRoles).values({ userId: user.id, roleId: roleRows[0]!.id });
  return user.id;
}

export async function teardown(): Promise<void> {
  await sql.end();
}
