/**
 * Master Consolidated Plan E-4 — Historical Backfill (§32–§34, §56).
 *
 * Pre-go-live weeks are recorded — never generated. This service contains NO
 * scheduling logic: no eligibility/fairness/previous-week-ABSENT evaluation,
 * no regeneration, no availability writes, no Current-Destination or
 * destination-history mutation, no master-data mutation of any kind
 * (Invariant 4). Rows are stored with assignment_source = HISTORICAL and stay
 * HISTORICAL forever (Invariant; corrections keep the source).
 *
 * Server-side separation (not UI-only):
 *   • historical.service rejects weeks at/after the go-live boundary;
 *   • scheduling.service and the normal Generate API reject weeks BEFORE it
 *     (HistoricalWeekError), so a historical week can never become a mixed
 *     AUTO week;
 *   • the language hard rule (Filipino teacher → English dako) applies to
 *     historical input too — such a row is REJECTED, and no teacher master
 *     profile is ever modified to accommodate it.
 *
 * Historical assignments COUNT toward future fairness (the counts query reads
 * all sources).
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import { assignments, dako, teachers, weeks } from "@/server/db/schema";
import { audit } from "./audit.service";
import { ForbiddenError, NotFoundError, ConflictError, ValidationError, AppError } from "@/lib/errors";
import { isTeacherEligibleForDako, type Language } from "@/lib/eligibility";
import { isNormalSchedulingWeek, SCHEDULING_GO_LIVE } from "@/server/config";
import type { SessionUser } from "@/server/auth/session";

export class HistoricalWeekError extends AppError {
  constructor(message: string) {
    super(message, 409, "HISTORICAL_WEEK");
  }
}

export function goLive(): { year: number; week: number } {
  return { ...SCHEDULING_GO_LIVE };
}

export interface HistoricalRowInput {
  dakoId: string;
  teacherId: string;
  assignmentType: "SUGO" | "RESERBA" | "RESERBA_II";
}

export interface HistoricalRowRecorded {
  id: string;
  dakoId: string;
  teacherId: string;
  assignmentType: string;
  assignmentSource: "HISTORICAL";
}

/**
 * Batch-record historical assignments for ONE pre-go-live week. Validation
 * per row: entities exist, language rule holds, slot + teacher-week
 * uniqueness. Week must not already contain normal-cycle (AUTO/MANUAL/
 * OVERRIDE) assignments. Fully transactional; audited with the complete
 * batch snapshot.
 */
export async function recordHistoricalAssignments(
  weekId: string,
  rows: HistoricalRowInput[],
  actor: SessionUser,
): Promise<{ recorded: HistoricalRowRecorded[]; week: { year: number; isoWeekNumber: number } }> {
  if (!actor.permissions.includes("assignments.write")) {
    throw new ForbiddenError("historical backfill requires the assignments.write permission");
  }
  return withTransaction(async (tx) => {
    const locked = await tx
      .select()
      .from(weeks)
      .where(eq(weeks.id, weekId))
      .for("update")
      .limit(1);
    const week = locked[0];
    if (!week) throw new NotFoundError("week not found");
    if (isNormalSchedulingWeek(week.year, week.isoWeekNumber)) {
      throw new HistoricalWeekError(
        `week ${week.year}-W${week.isoWeekNumber} is at/after the scheduling go-live ` +
          `(${SCHEDULING_GO_LIVE.year}-W${SCHEDULING_GO_LIVE.week}); use the normal Generate workflow`,
      );
    }

    const existing = await tx
      .select({ assignmentSource: assignments.assignmentSource })
      .from(assignments)
      .where(eq(assignments.weekId, weekId));
    if (existing.some((a) => a.assignmentSource !== "HISTORICAL")) {
      throw new ConflictError(
        "week already contains normal-cycle assignments; historical backfill cannot be mixed with them",
      );
    }

    const dakoIds = [...new Set(rows.map((r) => r.dakoId))];
    const teacherIds = [...new Set(rows.map((r) => r.teacherId))];
    const dakoRows = dakoIds.length
      ? await tx.select().from(dako).where(inArray(dako.id, dakoIds))
      : [];
    const teacherRows = teacherIds.length
      ? await tx.select().from(teachers).where(inArray(teachers.id, teacherIds))
      : [];
    const dakoById = new Map(dakoRows.map((d) => [d.id, d]));
    const teacherById = new Map(teacherRows.map((t) => [t.id, t]));

    const recorded: HistoricalRowRecorded[] = [];
    for (const r of rows) {
      const d = dakoById.get(r.dakoId);
      if (!d) throw new NotFoundError(`dako not found: ${r.dakoId}`);
      const t = teacherById.get(r.teacherId);
      if (!t) throw new NotFoundError(`teacher not found: ${r.teacherId}`);
      // Invariant 1 — the absolute language rule applies to historical input.
      // The row is rejected; the teacher's master language is NEVER modified
      // to make it pass (clarification #1 of the Master Plan).
      if (!isTeacherEligibleForDako(t.language as Language, d.language as Language)) {
        throw new ValidationError(
          `historical row rejected: ${t.teacherCode} (FILIPINO) cannot serve ENGLISH dako ${d.dakoCode} — ` +
            `LANGUAGE_MISMATCH is non-overrideable; the record stays unencoded unless the teacher's ` +
            `master language is legitimately corrected through the teacher-edit flow`,
        );
      }
      const dup = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          and(
            eq(assignments.weekId, weekId),
            eq(assignments.dakoId, r.dakoId),
            eq(assignments.assignmentType, r.assignmentType),
          ),
        )
        .limit(1);
      if (dup.length > 0) {
        throw new ConflictError(`${r.assignmentType} slot for dako ${d.dakoCode} already recorded for this week`);
      }
      const dupTeacher = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.weekId, weekId), eq(assignments.teacherId, r.teacherId)))
        .limit(1);
      if (dupTeacher.length > 0) {
        throw new ConflictError(`teacher ${t.teacherCode} already has a recorded assignment for this week`);
      }
      const inserted = await tx
        .insert(assignments)
        .values({
          weekId,
          dakoId: r.dakoId,
          teacherId: r.teacherId,
          assignmentType: r.assignmentType,
          assignmentSource: "HISTORICAL",
          status: "ASSIGNED",
          isOverride: false,
          assignedBy: actor.userId,
        })
        .returning();
      recorded.push({
        id: inserted[0]!.id,
        dakoId: r.dakoId,
        teacherId: r.teacherId,
        assignmentType: r.assignmentType,
        assignmentSource: "HISTORICAL",
      });
    }

    await audit(
      {
        user: actor,
        action: "HISTORICAL_BACKFILL_RECORDED",
        entityType: "week",
        entityId: weekId,
        oldValue: null,
        newValue: {
          week: `${week.year}-W${week.isoWeekNumber}`,
          count: recorded.length,
          rows: recorded,
        },
        reason: "Historical backfill recording",
      },
      tx,
    );
    return { recorded, week: { year: week.year, isoWeekNumber: week.isoWeekNumber } };
  });
}

/**
 * ADMIN correction of an already-recorded historical row (teacher and/or
 * type). Requires a mandatory reason; audited HISTORICAL_CORRECTION; the row
 * REMAINS assignment_source = HISTORICAL (Invariant 11). Language rule and
 * slot uniqueness re-checked. Master data untouched.
 */
export async function correctHistoricalAssignment(
  input: { assignmentId: string; teacherId?: string; assignmentType?: "SUGO" | "RESERBA" | "RESERBA_II" },
  reason: string,
  actor: SessionUser,
): Promise<typeof assignments.$inferSelect> {
  if (!actor.roleCodes.includes("ADMIN")) {
    throw new ForbiddenError("historical corrections require an administrator");
  }
  if (!reason || !reason.trim()) {
    throw new ValidationError("reason is required to correct a historical record");
  }
  return withTransaction(async (tx) => {
    const rows = await tx.select().from(assignments).where(eq(assignments.id, input.assignmentId)).limit(1);
    const before = rows[0];
    if (!before) throw new NotFoundError("assignment not found");
    if (before.assignmentSource !== "HISTORICAL") {
      throw new ConflictError("correction applies only to HISTORICAL-source assignments");
    }
    const w = await tx.select().from(weeks).where(eq(weeks.id, before.weekId)).limit(1);
    const week = w[0]!;
    if (isNormalSchedulingWeek(week.year, week.isoWeekNumber)) {
      throw new HistoricalWeekError("week is no longer a historical week");
    }
    const newTeacherId = input.teacherId ?? before.teacherId;
    const newType = input.assignmentType ?? (before.assignmentType as HistoricalRowInput["assignmentType"]);
    if (newTeacherId !== before.teacherId || newType !== before.assignmentType) {
      const tRows = await tx.select().from(teachers).where(eq(teachers.id, newTeacherId)).limit(1);
      const dRows = await tx.select().from(dako).where(eq(dako.id, before.dakoId)).limit(1);
      const t = tRows[0];
      const d = dRows[0];
      if (!t || !d) throw new NotFoundError("teacher or dako not found");
      if (!isTeacherEligibleForDako(t.language as Language, d.language as Language)) {
        throw new ValidationError("corrected row violates LANGUAGE_MISMATCH — non-overrideable");
      }
      const dup = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          and(
            eq(assignments.weekId, before.weekId),
            eq(assignments.dakoId, before.dakoId),
            eq(assignments.assignmentType, newType),
          ),
        )
        .limit(1);
      if (dup.length > 0 && dup[0]!.id !== before.id) {
        throw new ConflictError("target slot already recorded for this week");
      }
    }
    const updated = await tx
      .update(assignments)
      .set({
        teacherId: newTeacherId,
        assignmentType: newType,
        assignmentSource: "HISTORICAL", // stays HISTORICAL — never converted
        updatedAt: new Date(),
      })
      .where(eq(assignments.id, before.id))
      .returning();
    const row = updated[0]!;
    await audit(
      {
        user: actor,
        action: "HISTORICAL_CORRECTION",
        entityType: "assignment",
        entityId: before.id,
        oldValue: before,
        newValue: row,
        reason: reason.trim(),
      },
      tx,
    );
    return row;
  });
}

/** List pre-go-live weeks (for the Historical Backfill UI selector). */
export async function listHistoricalWeeks(): Promise<
  Array<{ id: string; year: number; isoWeekNumber: number; status: string; recorded: boolean }>
> {
  const db = getDb();
  const all = await db.select().from(weeks);
  const historical = all
    .filter((w) => !isNormalSchedulingWeek(w.year, w.isoWeekNumber))
    .sort((a, b) => a.year - b.year || a.isoWeekNumber - b.isoWeekNumber);
  const recorded = historical.length
    ? await db
        .select({ weekId: assignments.weekId })
        .from(assignments)
        .where(
          and(
            inArray(
              assignments.weekId,
              historical.map((w) => w.id),
            ),
            eq(assignments.assignmentSource, "HISTORICAL"),
          ),
        )
    : [];
  const recordedSet = new Set(recorded.map((r) => r.weekId));
  return historical.map((w) => ({
    id: w.id,
    year: w.year,
    isoWeekNumber: w.isoWeekNumber,
    status: w.status,
    recorded: recordedSet.has(w.id),
  }));
}

/** True when the week is served by the normal workflow (Generate UI filter). */
export function isNormalWeek(year: number, week: number): boolean {
  return isNormalSchedulingWeek(year, week);
}

export const db = getDb;
