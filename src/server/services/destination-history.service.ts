/**
 * Master Consolidated Plan E-3 — Destination History (§8/§9).
 *
 * ONE normalized relationship (destination_history, migration 0005; duty added
 * by 0013) serves both the teacher page and the dako page. A Current-Destination
 * change is transactional: close the previous period, create the new one, update
 * `teachers.current_destination_id`, audit. No dates are invented — the new
 * period starts when the edit is made (or at the explicitly provided start date).
 * Weekly Suguan assignments NEVER create or modify rows here (Invariant 3).
 * Records survive teacher INACTIVE and dako DISABLED states; history is
 * preserved and never rewritten.
 *
 * Guro Duty (New Update #6/#7/#8) — duty is a property of the RELATIONSHIP, not
 * of the teacher: each period carries the duty held at that dako, so history
 * keeps the duty of every past destination. Two consequences, both enforced
 * here and nowhere else:
 *   • A dako may hold one ACTIVE Destinado AND one ACTIVE Katuwang (the unique
 *     index is per (dako_id, duty)); re-assigning the SAME slot still replaces
 *     its holder, and an active period with no recorded duty keeps the original
 *     one-per-dako rule (it coalesces to the '' slot).
 *   • `teachers.duty` is kept as a MIRROR of the open period's duty, written in
 *     the same transaction, because the duty-based generation modes and the
 *     Magtuturo roster read that column. The relationship row stays the single
 *     source of truth; the mirror is never written by anything else that also
 *     writes the period.
 */
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import { dako, destinationHistory, teachers } from "@/server/db/schema";
import { audit } from "./audit.service";
import { ForbiddenError, NotFoundError, ConflictError, ValidationError } from "@/lib/errors";
import { formatFullName } from "@/lib/name";
import type { SessionUser } from "@/server/auth/session";

/** The only two duty values the system accepts. Nothing else is ever stored. */
export const DUTY_VALUES = ["DESTINADO", "KATUWANG"] as const;
export type Duty = (typeof DUTY_VALUES)[number];

/** True only for the two sanctioned duty codes. */
export function isDuty(value: unknown): value is Duty {
  return typeof value === "string" && (DUTY_VALUES as readonly string[]).includes(value);
}

export interface DestinationPeriod {
  id: string;
  teacherId: string;
  dakoId: string;
  dakoName: string | null;
  duty: Duty | null;
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
      duty: destinationHistory.duty,
      startDate: destinationHistory.startDate,
      endDate: destinationHistory.endDate,
    })
    .from(destinationHistory)
    .leftJoin(dako, eq(dako.id, destinationHistory.dakoId))
    .where(eq(destinationHistory.teacherId, teacherId))
    .orderBy(asc(destinationHistory.startDate), desc(destinationHistory.createdAt));
  return rows.map((r) => ({ ...r, duty: isDuty(r.duty) ? r.duty : null }));
}

/** Full history for one dako (teacher names resolved). */
export async function listForDako(dakoId: string): Promise<
  Array<{
    id: string;
    teacherId: string;
    teacherName: string;
    duty: Duty | null;
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
      duty: destinationHistory.duty,
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
    teacherName: formatFullName(r),
    duty: isDuty(r.duty) ? r.duty : null,
    startDate: r.startDate,
    endDate: r.endDate,
  }));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * End-date every ACTIVE period of one dako that occupies the given duty slot.
 * A period with no recorded duty occupies no displayed slot (''), so a
 * duty-bearing assignment ALSO supersedes it — otherwise a legacy unlabelled
 * period would linger as a current teacher the Dako view cannot label, which is
 * exactly the contradictory state this batch removes. Records are ended, never
 * deleted. Runs inside the caller's transaction.
 */
async function closeDakoSlot(
  tx: Database,
  dakoId: string,
  duty: Duty | null,
  endDate: string,
  excludePeriodId?: string,
): Promise<number> {
  const conditions = [
    eq(destinationHistory.dakoId, dakoId),
    isNull(destinationHistory.endDate),
    duty === null ? isNull(destinationHistory.duty) : eq(destinationHistory.duty, duty),
  ];
  if (excludePeriodId) conditions.push(ne(destinationHistory.id, excludePeriodId));
  const slotClosed = await tx
    .update(destinationHistory)
    .set({ endDate, updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: destinationHistory.id });
  // Same-slot rule only; a legacy unlabelled period never blocks a labelled one.
  if (duty !== null) {
    const unlabelled = await tx
      .update(destinationHistory)
      .set({ endDate, updatedAt: new Date() })
      .where(
        and(
          eq(destinationHistory.dakoId, dakoId),
          isNull(destinationHistory.endDate),
          isNull(destinationHistory.duty),
        ),
      )
      .returning({ id: destinationHistory.id });
    if (excludePeriodId) {
      // The caller may be re-slotting its OWN unlabelled period in place — do
      // not double-close the row that is about to receive the new duty.
      return slotClosed.length + unlabelled.filter((u) => u.id !== excludePeriodId).length;
    }
    return slotClosed.length + unlabelled.length;
  }
  return slotClosed.length;
}

/**
 * Assign a teacher to a dako as their Current Destination (optionally with the
 * duty held there) — the single sanctioned mutation path for destination
 * history. Transactional:
 *   1. close the teacher's active period (if the dako CHANGES),
 *   2. close the target dako's active period IN THE SAME DUTY SLOT,
 *   3. create the new active period (carrying the duty),
 *   4. update teachers.current_destination_id and mirror teachers.duty,
 *   5. audit with old/new values.
 * One-active-per-teacher and one-active-per-(dako, duty) are additionally
 * enforced by partial unique indexes; an identical re-assign is a no-op, and a
 * duty-only change at the SAME dako updates the open period in place (no
 * fabricated period boundary, still audited).
 */
export async function assignDestination(
  teacherId: string,
  dakoId: string,
  actor: SessionUser,
  opts?: { startDate?: string; duty?: Duty | null; tx?: Database },
): Promise<{ periodId: string; startDate: string; duty: Duty | null }> {
  // Defense-in-depth beyond the route guard — roleCodes, not the
  // route-resolved permissions array (unit-test actors carry roles only).
  if (!actor.roleCodes.includes("ADMIN") && !actor.roleCodes.includes("SCHEDULER")) {
    throw new ForbiddenError("destination changes require an administrator or scheduler/encoder");
  }
  const startDate = opts?.startDate ?? today();
  const duty = opts?.duty ?? null;
  // Only the two sanctioned duty codes are ever written (the column CHECK is a
  // second, independent guard).
  if (duty !== null && !isDuty(duty)) {
    throw new ValidationError("duty must be DESTINADO or KATUWANG");
  }
  const run = async (tx: Database): Promise<{ periodId: string; startDate: string; duty: Duty | null }> => {
    const tRows = await tx.select().from(teachers).where(eq(teachers.id, teacherId)).limit(1);
    const teacher = tRows[0];
    if (!teacher) throw new NotFoundError("teacher not found");
    const dRows = await tx.select().from(dako).where(eq(dako.id, dakoId)).limit(1);
    const target = dRows[0];
    if (!target) throw new NotFoundError("dako not found");
    if (target.status !== "ACTIVE") {
      throw new ValidationError("only ACTIVE dako can be selected as Current Destination");
    }

    const openRows = await tx
      .select({ id: destinationHistory.id, startDate: destinationHistory.startDate, duty: destinationHistory.duty })
      .from(destinationHistory)
      .where(and(eq(destinationHistory.teacherId, teacherId), isNull(destinationHistory.endDate)))
      .limit(1);
    const open = openRows[0];
    const openDuty: Duty | null = open && isDuty(open.duty) ? open.duty : null;

    // Same destination: only the DUTY can change, and it changes in place.
    if (teacher.currentDestinationId === dakoId && open) {
      if (openDuty === duty) {
        return { periodId: open.id, startDate: open.startDate, duty }; // true no-op
      }
      await closeDakoSlot(tx, dakoId, duty, startDate, open.id);
      await tx
        .update(destinationHistory)
        .set({ duty, updatedAt: new Date() })
        .where(eq(destinationHistory.id, open.id));
      await tx
        .update(teachers)
        .set({ duty, updatedAt: new Date() })
        .where(eq(teachers.id, teacherId));
      await audit(
        {
          user: actor,
          action: "DESTINATION_ASSIGNED",
          entityType: "teacher",
          entityId: teacherId,
          oldValue: { currentDestinationId: dakoId, duty: openDuty },
          newValue: { currentDestinationId: dakoId, duty, destinationPeriodId: open.id, startDate: open.startDate },
          reason: "Guro duty change at the current destination",
        },
        tx,
      );
      return { periodId: open.id, startDate: open.startDate, duty };
    }

    const previous = teacher.currentDestinationId;
    const previousDuty: Duty | null = isDuty(teacher.duty) ? teacher.duty : null;
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
    // Free the target dako's slot for this duty (never another slot's holder).
    const slotClosed = await closeDakoSlot(tx, dakoId, duty, startDate);

    const inserted = await tx
      .insert(destinationHistory)
      .values({ teacherId, dakoId, startDate, duty })
      .returning({ id: destinationHistory.id });
    await tx
      .update(teachers)
      .set({ currentDestinationId: dakoId, duty, updatedAt: new Date() })
      .where(eq(teachers.id, teacherId));

    await audit(
      {
        user: actor,
        action: "DESTINATION_ASSIGNED",
        entityType: "teacher",
        entityId: teacherId,
        oldValue: {
          currentDestinationId: previous,
          duty: previousDuty,
          destinationHistoryClosed: closed,
          dakoSlotClosed: slotClosed > 0,
        },
        newValue: { currentDestinationId: dakoId, duty, destinationPeriodId: inserted[0]!.id, startDate },
        reason: "Current Destination change",
      },
      tx,
    );
    return { periodId: inserted[0]!.id, startDate, duty };
  };
  return opts?.tx ? run(opts.tx) : withTransaction(run);
}

/**
 * Keep the open period's duty aligned with a master-data duty edit made through
 * the teacher form. Only the OPEN period is touched (history is immutable from
 * here), and the caller has already written the same value to teachers.duty, so
 * the mirror stays exact. No period is created and none is ended.
 */
export async function syncOpenPeriodDuty(
  teacherId: string,
  duty: Duty | null,
  tx?: Database,
): Promise<number> {
  if (duty !== null && !isDuty(duty)) {
    throw new ValidationError("duty must be DESTINADO or KATUWANG");
  }
  const run = async (db: Database): Promise<number> => {
    const updated = await db
      .update(destinationHistory)
      .set({ duty, updatedAt: new Date() })
      .where(and(eq(destinationHistory.teacherId, teacherId), isNull(destinationHistory.endDate)))
      .returning({ id: destinationHistory.id });
    return updated.length;
  };
  return tx ? run(tx) : withTransaction(run);
}

/**
 * Explicit ADMIN correction of an existing historical period (dates, duty or
 * dako re-assignment). Requires a reason; audited; never rewrites other periods.
 */
export async function correctPeriod(
  periodId: string,
  patch: { endDate?: string; startDate?: string; duty?: Duty | null },
  reason: string,
  actor: SessionUser,
): Promise<typeof destinationHistory.$inferSelect> {
  if (!actor.roleCodes.includes("ADMIN") && !actor.roleCodes.includes("SCHEDULER")) {
    throw new ForbiddenError("destination corrections require an administrator or scheduler/encoder");
  }
  if (!reason || !reason.trim()) {
    throw new ValidationError("reason is required to correct a destination period");
  }
  if (patch.duty !== undefined && patch.duty !== null && !isDuty(patch.duty)) {
    throw new ValidationError("duty must be DESTINADO or KATUWANG");
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
 * Duty of the teacher's OPEN period — the relationship duty the teacher page
 * displays. null when no period is open or none was recorded (never inferred).
 */
export async function activePeriodDuty(teacherId: string): Promise<Duty | null> {
  const rows = await getDb()
    .select({ duty: destinationHistory.duty })
    .from(destinationHistory)
    .where(and(eq(destinationHistory.teacherId, teacherId), isNull(destinationHistory.endDate)))
    .limit(1);
  const value = rows[0]?.duty;
  return isDuty(value) ? value : null;
}

/**
 * Close the teacher's active destination period (used by the sanctioned
 * "clear Current Destination" flow). Records are preserved — end-dated, not
 * deleted. `teachers.duty` is deliberately NOT cleared: duty is master data the
 * teacher keeps, and with no open period there is no relationship duty to
 * mirror (nothing displays a duty for a cleared destination). Transactional when
 * called inside the caller's transaction.
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
export const DESTINATION_HISTORY_WRITE_OWNERS = [
  "assignDestination",
  "syncOpenPeriodDuty",
  "correctPeriod",
  "closeActiveDestination",
] as const;
