import { and, eq } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import { weeks, assignments } from "@/server/db/schema";
import { weekCreateSchema, weekStatusUpdateSchema } from "@/lib/validation/schemas";
import { isoWeek, isoWeekDates, isoWeeksInYear } from "@/lib/iso-week";
import { ValidationError, NotFoundError, ConflictError } from "@/lib/errors";
import { audit } from "./audit.service";
import type { SessionUser } from "@/server/auth/session";

export async function createWeek(
  input: unknown,
  actor: SessionUser,
): Promise<typeof weeks.$inferSelect> {
  const { year, isoWeekNumber } = weekCreateSchema.parse(input);
  if (isoWeekNumber > isoWeeksInYear(year)) {
    throw new ValidationError(`year ${year} has only ${isoWeeksInYear(year)} ISO weeks`);
  }
  const { startDate, endDate } = isoWeekDates(year, isoWeekNumber);
  return withTransaction(async (tx) => {
    const existing = await tx
      .select()
      .from(weeks)
      .where(and(eq(weeks.year, year), eq(weeks.isoWeekNumber, isoWeekNumber)))
      .limit(1);
    if (existing.length > 0) throw new ConflictError("week already exists");
    const inserted = await tx
      .insert(weeks)
      .values({ year, isoWeekNumber, startDate, endDate, status: "DRAFT" })
      .returning();
    const row = inserted[0]!;
    await audit(
      { user: actor, action: "CREATED_WEEK", entityType: "week", entityId: row.id, newValue: row },
      tx as Database,
    );
    return row;
  });
}

export async function getOrCreateWeek(year: number, isoWeekNumber: number): Promise<typeof weeks.$inferSelect> {
  const db = getDb();
  const existing = await db
    .select()
    .from(weeks)
    .where(and(eq(weeks.year, year), eq(weeks.isoWeekNumber, isoWeekNumber)))
    .limit(1);
  if (existing[0]) return existing[0];
  if (isoWeekNumber > isoWeeksInYear(year)) {
    throw new ValidationError(`year ${year} has only ${isoWeeksInYear(year)} ISO weeks`);
  }
  const { startDate, endDate } = isoWeekDates(year, isoWeekNumber);
  const inserted = await db
    .insert(weeks)
    .values({ year, isoWeekNumber, startDate, endDate, status: "DRAFT" })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  const again = await db
    .select()
    .from(weeks)
    .where(and(eq(weeks.year, year), eq(weeks.isoWeekNumber, isoWeekNumber)))
    .limit(1);
  if (!again[0]) throw new ConflictError("week could not be created");
  return again[0];
}

export async function getWeek(id: string) {
  const rows = await getDb().select().from(weeks).where(eq(weeks.id, id)).limit(1);
  if (!rows[0]) throw new NotFoundError("week not found");
  return rows[0];
}

export async function listWeeks(year?: number) {
  const q = getDb().select().from(weeks);
  return year ? q.where(eq(weeks.year, year)).orderBy(weeks.isoWeekNumber) : q.orderBy(weeks.year, weeks.isoWeekNumber);
}

/** Lifecycle: DRAFT → FINALIZED → PUBLISHED (§16). Unlock is ADMIN-only. */
export async function setWeekStatus(
  id: string,
  input: unknown,
  actor: SessionUser,
): Promise<typeof weeks.$inferSelect> {
  const { status, reason } = weekStatusUpdateSchema.parse(input);
  return withTransaction(async (tx) => {
    const rows = await tx.select().from(weeks).where(eq(weeks.id, id)).limit(1);
    const current = rows[0]?.status;
    if (!rows[0] || !current) throw new NotFoundError("week not found");
    const allowed: Record<string, string[]> = {
      DRAFT: ["FINALIZED"],
      FINALIZED: ["PUBLISHED", "DRAFT"],
      PUBLISHED: [],
    };
    if (current === status) throw new ConflictError(`week is already ${status}`);
    if (!allowed[current]?.includes(status)) {
      throw new ConflictError(`invalid transition ${current} → ${status}`);
    }
    if (status === "DRAFT") {
      // Back to draft == unlock: ADMIN-only, audited with mandatory reason.
      if (!actor.roleCodes.includes("ADMIN")) throw new ConflictError("only ADMIN can unlock a finalized week");
      if (!reason) throw new ValidationError("reason is required to unlock a schedule");
      await audit(
        { user: actor, action: "UNLOCKED_SCHEDULE", entityType: "week", entityId: id, oldValue: rows[0]!, newValue: { status }, reason },
        tx as Database,
      );
    }
    const updated = await tx.update(weeks).set({ status }).where(eq(weeks.id, id)).returning();
    const row = updated[0]!;
    if (status !== "DRAFT") {
      await audit(
        { user: actor, action: status === "FINALIZED" ? "FINALIZED_SCHEDULE" : "PUBLISHED_SCHEDULE", entityType: "week", entityId: id, oldValue: rows[0]!, newValue: row, reason: reason ?? null },
        tx as Database,
      );
    }
    return row;
  });
}

/** Guard used by assignment writes: finalized/published weeks are immutable. */
export async function assertWeekMutable(tx: Database, weekId: string): Promise<void> {
  const rows = await tx.select({ status: weeks.status }).from(weeks).where(eq(weeks.id, weekId)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("week not found");
  if (row.status !== "DRAFT") {
    throw new ConflictError(`week is ${row.status}; schedule changes require unlock`);
  }
}

export async function weekHasAssignments(tx: Database, weekId: string): Promise<boolean> {
  const rows = await tx.select({ id: assignments.id }).from(assignments).where(eq(assignments.weekId, weekId)).limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Phase 3 §5 — week resolution / adjacency / current week.
// Purely additive: the DRAFT → FINALIZED → PUBLISHED lifecycle and
// assertWeekMutable above are untouched.
// ---------------------------------------------------------------------------

/** Resolve a week by id, or by {year, week} (auto-creating DRAFT when missing). */
export async function resolveWeek(
  ref: { weekId?: string; year?: number; week?: number },
): Promise<typeof weeks.$inferSelect> {
  if (ref.weekId) return getWeek(ref.weekId);
  if (typeof ref.year === "number" && typeof ref.week === "number") {
    if (ref.week < 1 || ref.week > isoWeeksInYear(ref.year)) {
      throw new ValidationError(`year ${ref.year} has only ${isoWeeksInYear(ref.year)} ISO weeks`);
    }
    return getOrCreateWeek(ref.year, ref.week);
  }
  throw new ValidationError("provide either weekId or {year, week}");
}

/**
 * The week `offset` ISO weeks from `weekId` (−1 previous, +1 next).
 * Start-date arithmetic — handles year wrap (W1 ↔ W52/53) and 53-week years.
 * The adjacent week is auto-created as DRAFT when missing.
 */
export async function adjacentWeek(
  weekId: string,
  offset: -1 | 1,
): Promise<typeof weeks.$inferSelect> {
  const cur = await getWeek(weekId);
  const start = new Date(`${cur.startDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + offset * 7);
  const next = isoWeek(start);
  return getOrCreateWeek(next.year, next.week);
}

/** The ISO week containing today (auto-created as DRAFT when missing). */
export async function currentWeek(): Promise<typeof weeks.$inferSelect> {
  const { year, week } = isoWeek(new Date());
  return getOrCreateWeek(year, week);
}
