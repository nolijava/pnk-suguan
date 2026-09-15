import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { auditLogs, users } from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/session";

const SENSITIVE_KEYS = new Set(["password", "newPassword", "currentPassword", "passwordHash", "token"]);

function sanitize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k) ? "[REDACTED]" : v;
  }
  return out;
}

export interface AuditEntry {
  user?: Pick<SessionUser, "userId"> | null;
  action: string; // e.g. "CREATED_TEACHER", "DISABLED_DAKO", "FINALIZED_SCHEDULE"
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}

export async function audit(entry: AuditEntry, tx?: Database): Promise<void> {
  const db = tx ?? getDb();
  await db.insert(auditLogs).values({
    userId: entry.user?.userId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    oldValue: sanitize(entry.oldValue) as never,
    newValue: sanitize(entry.newValue) as never,
    reason: entry.reason ?? null,
  });
}

export interface AuditListRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  userId: string | null;
  userEmail: string | null;
  createdAt: Date;
}

/**
 * Append-only audit listing with optional entity scoping. Audit rows are
 * written once and never updated (DB triggers reject UPDATE/DELETE).
 */
export async function listAuditLogs(opts: {
  entityType?: string;
  entityId?: string;
  action?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<{ rows: AuditListRow[]; total: number; page: number; pageCount: number }> {
  const conds = [];
  if (opts.entityType) conds.push(eq(auditLogs.entityType, opts.entityType));
  if (opts.entityId) conds.push(eq(auditLogs.entityId, opts.entityId));
  if (opts.action) conds.push(eq(auditLogs.action, opts.action));
  const whereClause = conds.length > 0 ? and(...conds) : undefined;

  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));

  const cols = getTableColumns(auditLogs);
  const rows = (await getDb()
    .select({
      id: cols.id,
      action: cols.action,
      entityType: cols.entityType,
      entityId: cols.entityId,
      oldValue: cols.oldValue,
      newValue: cols.newValue,
      reason: cols.reason,
      userId: cols.userId,
      userEmail: users.email,
      createdAt: cols.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(whereClause)
    .orderBy(desc(cols.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)) as AuditListRow[];

  const countRows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(whereClause);
  const total = countRows[0]?.n ?? 0;
  return { rows, total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
