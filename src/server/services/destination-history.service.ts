/**
 * Master Consolidated Plan E-3 — Destination History (§8/§9).
 *
 * ONE normalized relationship (destination_history, migration 0005) serves
 * both the teacher page and the dako page. A Current-Destination change is
 * transactional: close the previous period, create the new one, update
 * `teachers.current_destination_id`, audit. No dates are invented — the new
 * period starts when the edit is made (or at the explicitly provided start
 * date). Weekly Suguan assignments NEVER create or modify rows here
 * (Invariant 3). Records survive teacher INACTIVE and dako DISABLED states;
 * history is preserved and never rewritten.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import { dako, destinationHistory, teachers } from "@/server/db/schema";
import { audit } from "./audit.service";
import { ForbiddenError, NotFoundError, ConflictError, ValidationError } from "@/lib/errors";
import type { SessionUser } from "@/server/auth/session";

export interface DestinationPeriod {
  id: string;
  teacherId: string;
  dakoId: string;
  dakoName: string | null;
  startDate: string;
  endDate: string | null;
}

/** Full history for one teacher (dako page field set included). */
export async function listForTeacher(teacherId: string): Promise<DestinationPeriod[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: destinationHistory.id,
      teacherId: destinationHistory.teacherId,
      dakoId: destinationHistory.dakoId,
      dakoName: dako.name,
      startDate: destinationHistory.startDate,
      endDate: destinationHistory.endDate,
    })
    .from(destinationHistory)
    .leftJoin(dako, eq(dako.id, destinationHistory.dakoId))
    .where(eq(destinationHistory.teacherId, teacherId))
    .orderBy(asc(destinationHistory.startDate), desc(destinationHistory.createdAt));
  return rows;
}

/** Full history for one dako (teacher names resolved). */
export async function listForDako(dakoId: string): Promise<
  Array<{
    id: string;
    teacherId: string;
    teacherName: string;
    startDate: string;
    endDate: string | null;
  }>
> {
  const db = getDb();
  const rows = await db
    .select({
      id: destinationHistory.id,
      teacherId: destinationHistory.teacherId,
      firstName: teachers.firstName,
      middleName: teachers.middleName,
      lastName: teachers.lastName,
      suffix: teachers.suffix,
      startDate: destinationHistory.startDate,
      endDate: destinationHistory.endDate,
    })
    .from(destinationHistory)
    .innerJoin(teachers, eq(teachers.id, destinationHistory.teacherId))
    .where(eq(destinationHistory.dakoId, dakoId))
    .orderBy(asc(destinationHistory.startDate), desc(destinationHistory.createdAt));
  return rows.map((r) => ({
    id: r.id,
    teacherId: r.teacherId,
    teacherName: [r.firstName, r.middleName, r.lastName, r.suffix].filter(Boolean).join(" "),
    startDate: r.startDate,
    endDate: r.endDate,
  }));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Assign a teacher to a dako as their Current Destination — the single
 * sanctioned mutation path for destination history. Transactional:
 *   1. close the teacher's active period (if any),
 *   2. close the dako's active period (if any),
 *   3. create the new active period,
 *   4. update teachers.current_destination_id,
 *   5. audit with old/new values.
 * One-active-per-teacher and one-active-per-dako are additionally enforced by
 * partial unique indexes (migration 0005); a same-dako re-assign is a no-op.
 */
export async function assignDestination(
  teacherId: string,
  dakoId: string,
  actor: SessionUser,
  opts?: { startDate?: string; tx?: Database },
): Promise<{ periodId: string; startDate: string }> {
  // Defense-in-depth beyond the route guard — roleCodes, not the
  // route-resolved permissions array (unit-test actors carry roles only).
  if (!actor.roleCodes.includes("ADMIN") && !actor.roleCodes.includes("SCHEDULER")) {
    throw new ForbiddenError("destination changes require an administrator or scheduler/encoder");
  }
  const startDate = opts?.startDate ?? today();
  const run = async (tx: Database): Promise<{ periodId: string; startDate: string }> => {
    const tRows = await tx.select().from(teachers).where(eq(teachers.id, teacherId)).limit(1);
    const teacher = tRows[0];
    if (!teacher) throw new NotFoundError("teacher not found");
    const dRows = await tx.select().from(dako).where(eq(dako.id, dakoId)).limit(1);
    const target = dRows[0];
    if (!target) throw new NotFoundError("dako not found");
    if (target.status !== "ACTIVE") {
      throw new ValidationError("only ACTIVE dako can be selected as Current Destination");
    }
    if (teacher.currentDestinationId === dakoId) {
      // Same destination → no-op (no period churn, no audit noise).
      const existing = await tx
        .select({ id: destinationHistory.id, startDate: destinationHistory.startDate })
        .from(destinationHistory)
        .where(and(eq(destinationHistory.teacherId, teacherId), isNull(destinationHistory.endDate)))
        .limit(1);
      return { periodId: existing[0]?.id ?? "", startDate: existing[0]?.startDate ?? startDate };
    }

    const previous = teacher.currentDestinationId;
    let closed = false;
    if (previous) {
      const updated = await tx
        .update(destinationHistory)
        .set({ endDate: startDate, updatedAt: new Date() })
        .where(
          and(
            eq(destinationHistory.teacherId, teacherId),
            isNull(destinationHistory.endDate),
          ),
        )
        .returning({ id: destinationHistory.id });
      closed = updated.length > 0;
    } else {
      // First recorded destination: no previous period exists to close —
      // nothing is invented for the pre-history gap.
      closed = false;
    }
    // Free the dako's active period (if another teacher still holds it).
    await tx
      .update(destinationHistory)
      .set({ endDate: startDate, updatedAt: new Date() })
      .where(and(eq(destinationHistory.dakoId, dakoId), isNull(destinationHistory.endDate)));

    const inserted = await tx
      .insert(destinationHistory)
      .values({ teacherId, dakoId, startDate })
      .returning({ id: destinationHistory.id });
    await tx
      .update(teachers)
      .set({ currentDestinationId: dakoId, updatedAt: new Date() })
      .where(eq(teachers.id, teacherId));

    await audit(
      {
        user: actor,
        action: "DESTINATION_ASSIGNED",
        entityType: "teacher",
        entityId: teacherId,
        oldValue: { currentDestinationId: previous, destinationHistoryClosed: closed },
        newValue: { currentDestinationId: dakoId, destinationPeriodId: inserted[0]!.id, startDate },
        reason: "Current Destination change",
      },
      tx,
    );
    return { periodId: inserted[0]!.id, startDate };
  };
  return opts?.tx ? run(opts.tx) : withTransaction(run);
}

/**
 * Explicit ADMIN correction of an existing historical period (dates or dako
 * re-assignment). Requires a reason; audited; never rewrites other periods.
 */
export async function correctPeriod(
  periodId: string,
  patch: { endDate?: string; startDate?: string },
  reason: string,
  actor: SessionUser,
): Promise<typeof destinationHistory.$inferSelect> {
  if (!actor.roleCodes.includes("ADMIN") && !actor.roleCodes.includes("SCHEDULER")) {
    throw new ForbiddenError("destination corrections require an administrator or scheduler/encoder");
  }
  if (!reason || !reason.trim()) {
    throw new ValidationError("reason is required to correct a destination period");
  }
  return withTransaction(async (tx) => {
    const rows = await tx
      .select()
      .from(destinationHistory)
      .where(eq(destinationHistory.id, periodId))
      .limit(1);
    const before = rows[0];
    if (!before) throw new NotFoundError("destination period not found");
    const updated = await tx
      .update(destinationHistory)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(destinationHistory.id, periodId))
      .returning();
    const row = updated[0]!;
    if (row.endDate && row.startDate > row.endDate) {
      throw new ConflictError("corrected period would end before it starts");
    }
    await audit(
      {
        user: actor,
        action: "DESTINATION_CORRECTED",
        entityType: "destination_history",
        entityId: periodId,
        oldValue: before,
        newValue: row,
        reason: reason.trim(),
      },
      tx,
    );
    return row;
  });
}

/**
 * Close the teacher's active destination period (used by the sanctioned
 * "clear Current Destination" flow). Records are preserved — end-dated, not
 * deleted. Transactional when called inside the caller's transaction.
 */
export async function closeActiveDestination(teacherId: string, tx?: Database): Promise<void> {
  const run = async (db: Database): Promise<void> => {
    await db
      .update(destinationHistory)
      .set({ endDate: today(), updatedAt: new Date() })
      .where(and(eq(destinationHistory.teacherId, teacherId), isNull(destinationHistory.endDate)));
  };
  return tx ? run(tx) : withTransaction(run);
}

/**
 * Invariant-3 guard used by tests and by future callers: destination rows are
 * written ONLY here. Weekly assignment services do not import this module's
 * mutation functions.
 */
export const DESTINATION_HISTORY_WRITE_OWNERS = ["assignDestination", "correctPeriod", "closeActiveDestination"] as const;
