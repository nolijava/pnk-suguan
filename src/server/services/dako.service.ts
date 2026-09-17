import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";

import { getDb, withTransaction, type Database } from "@/server/db/client";
import { dako } from "@/server/db/schema";
import { dakoCreateSchema, dakoUpdateSchema, type DakoCreateInput } from "@/lib/validation/schemas";
import { ValidationError, NotFoundError, ConflictError } from "@/lib/errors";
import { nextAnniversary } from "@/lib/anniversary";
import { audit } from "./audit.service";
import type { SessionUser } from "@/server/auth/session";
import { isUniqueViolation } from "./teacher.service";

export async function createDako(
  input: DakoCreateInput,
  actor: SessionUser,
): Promise<typeof dako.$inferSelect> {
  dakoCreateSchema.parse(input);
  return withTransaction(async (tx) => {
    // Phase 6 §23-§24: concurrency-safe auto code when omitted (UI never sends
    // one). nextval runs INSIDE the transaction — two simultaneous creates can
    // never collide; gaps from rollbacks are permanent (no reuse).
    let code = input.dakoCode;
    if (!code) {
      const n = await tx.execute(sql`select nextval('pnk_dako_code_seq') as nextval`);
      code = `ILGD-${n[0]!.nextval}`;
    }
    try {
      const inserted = await tx.insert(dako).values({ ...input, dakoCode: code }).returning();
      const row = inserted[0]!;
      await audit(
        { user: actor, action: "CREATED_DAKO", entityType: "dako", entityId: row.id, newValue: row },
        tx as Database,
      );
      return row;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new ConflictError("dako_code already exists");
      throw err;
    }
  });
}

export async function updateDako(
  id: string,
  input: unknown,
  actor: SessionUser,
): Promise<typeof dako.$inferSelect> {
  const patch = dakoUpdateSchema.parse(input);
  return withTransaction(async (tx) => {
    const before = await tx.select().from(dako).where(eq(dako.id, id)).limit(1);
    if (before.length === 0) throw new NotFoundError("dako not found");
    try {
      const updated = await tx.update(dako).set(patch).where(eq(dako.id, id)).returning();
      const row = updated[0]!;
      await audit(
        { user: actor, action: "UPDATED_DAKO", entityType: "dako", entityId: id, oldValue: before[0], newValue: row },
        tx as Database,
      );
      return row;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new ConflictError("dako_code already exists");
      throw err;
    }
  });
}

/** Soft disable (§13): retains the record for history; requires a reason. */
export async function disableDako(
  id: string,
  disableReason: string,
  actor: SessionUser,
): Promise<typeof dako.$inferSelect> {
  if (!disableReason.trim()) throw new ValidationError("disable reason is required");
  return withTransaction(async (tx) => {
    const before = await tx.select().from(dako).where(eq(dako.id, id)).limit(1);
    const prior = before[0];
    if (!prior) throw new NotFoundError("dako not found");
    if (prior.status === "DISABLED") throw new ConflictError("dako already disabled");
    const updated = await tx
      .update(dako)
      .set({ status: "DISABLED", dateDisabled: new Date().toISOString().slice(0, 10), disableReason })
      .where(eq(dako.id, id))
      .returning();
    const row = updated[0]!;
    await audit(
      { user: actor, action: "DISABLED_DAKO", entityType: "dako", entityId: id, oldValue: before[0], newValue: row, reason: disableReason },
      tx as Database,
    );
    return row;
  });
}

export async function enableDako(id: string, actor: SessionUser): Promise<typeof dako.$inferSelect> {
  return withTransaction(async (tx) => {
    const before = await tx.select().from(dako).where(eq(dako.id, id)).limit(1);
    const prior = before[0];
    if (!prior) throw new NotFoundError("dako not found");
    if (prior.status === "ACTIVE") throw new ConflictError("dako already active");
    const updated = await tx
      .update(dako)
      .set({ status: "ACTIVE", dateDisabled: null, disableReason: null })
      .where(eq(dako.id, id))
      .returning();
    const row = updated[0]!;
    await audit(
      { user: actor, action: "ENABLED_DAKO", entityType: "dako", entityId: id, oldValue: prior, newValue: row },
      tx as Database,
    );
    return row;
  });
}

export async function getDako(id: string) {
  const rows = await getDb().select().from(dako).where(eq(dako.id, id)).limit(1);
  if (!rows[0]) throw new NotFoundError("dako not found");
  return rows[0];
}

export type DakoSortField = "code" | "name" | "worshipDay" | "dateEstablished" | "status";

export interface DakoListOptions {
  status?: "ACTIVE" | "DISABLED";
  language?: string;
  purokGrupo?: string;
  worshipDay?: string;
  search?: string;
  sort?: DakoSortField;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface DakoListRow {
  id: string;
  dakoCode: string;
  name: string;
  address: string;
  purokGrupo: string | null;
  worshipDay: string;
  worshipTime: string;
  language: string;
  status: string;
}

/**
 * §13 Dako list: search (code/name/address/purok), filters Status/Language/
 * Purok/Worship Day (purok IS a dako filter per spec), whitelisted sorts, pagination.
 */
export async function listDako(opts: DakoListOptions = {}): Promise<{ rows: DakoListRow[]; total: number; page: number; pageCount: number }> {
  const conds = [];
  if (opts.status) conds.push(eq(dako.status, opts.status));
  if (opts.language) conds.push(eq(dako.language, opts.language));
  if (opts.purokGrupo) conds.push(eq(dako.purokGrupo, opts.purokGrupo));
  if (opts.worshipDay) conds.push(eq(dako.worshipDay, opts.worshipDay));
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`;
    conds.push(
      or(
        ilike(dako.dakoCode, term),
        ilike(dako.name, term),
        ilike(dako.address, term),
        ilike(dako.purokGrupo, term),
      ),
    );
  }
  const whereClause = conds.length > 0 ? and(...conds) : undefined;

  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const sortCol = {
    code: dako.dakoCode,
    name: dako.name,
    worshipDay: dako.worshipDay,
    dateEstablished: dako.dateEstablished,
    status: dako.status,
  }[opts.sort ?? "name"];
  const dir = opts.order === "desc" ? desc : asc;

  const rows = await getDb()
    .select({
      id: dako.id,
      dakoCode: dako.dakoCode,
      name: dako.name,
      address: dako.address,
      purokGrupo: dako.purokGrupo,
      worshipDay: dako.worshipDay,
      worshipTime: dako.worshipTime,
      language: dako.language,
      status: dako.status,
    })
    .from(dako)
    .where(whereClause)
    .orderBy(dir(sortCol))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const countRows = await getDb().select({ n: sql<number>`count(*)::int` }).from(dako).where(whereClause);
  const total = countRows[0]?.n ?? 0;
  return { rows, total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** §13 filter dropdown source: distinct purok/grupo values across all dako. */
export async function listDakoPurokGroups(): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ purokGrupo: dako.purokGrupo })
    .from(dako)
    .orderBy(asc(dako.purokGrupo));
  return rows.map((r) => r.purokGrupo).filter((p): p is string => p !== null && p !== "");
}

export interface DakoDetails {
  dako: typeof dako.$inferSelect;
  anniversary: {
    yearsCompleted: number;
    nextDate: string;
    anniversaryYear: number;
    daysUntil: number;
  };
}

/** §24 Dako details with computed anniversary (never stored as editable data). */
export async function getDakoDetails(id: string): Promise<DakoDetails> {
  const dakoRow = await getDako(id);
  const next = nextAnniversary(dakoRow.dateEstablished);
  // Years completed AS OF TODAY: the upcoming anniversary turns year N; if it has
  // not arrived yet we have completed N-1. On the day itself, N is completed.
  const yearsOnNext = next.anniversaryYear - Number(dakoRow.dateEstablished.slice(0, 4));
  const yearsCompleted = next.daysUntil === 0 ? yearsOnNext : yearsOnNext - 1;
  return {
    dako: dakoRow,
    anniversary: {
      yearsCompleted,
      nextDate: next.date.toISOString().slice(0, 10),
      anniversaryYear: next.anniversaryYear,
      daysUntil: next.daysUntil,
    },
  };
}

export async function countActiveDako(): Promise<number> {
  const rows = await getDb().select({ n: sql<number>`count(*)::int` }).from(dako).where(eq(dako.status, "ACTIVE"));
  return rows[0]?.n ?? 0;
}
