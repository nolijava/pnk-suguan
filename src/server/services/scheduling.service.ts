/**
 * Phase 4 — transactional scheduling service (§13/§14/§18).
 *
 * Generation is DRAFT-only, transaction-serialized on the week row, and
 * idempotent: AUTO assignments are replaced; MANUAL/OVERRIDE assignments are
 * preserved untouched. The complete previous AUTO set is snapshotted into the
 * REGENERATED_SCHEDULE audit row so history stays reconstructable even though
 * deleted rows cascade their assignment_history children.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import {
  assignments,
  auditLogs,
  dako,
  teachers,
  weeks,
} from "@/server/db/schema";
import { ValidationError, NotFoundError, ConflictError } from "@/lib/errors";
import { audit } from "./audit.service";
import type { SessionUser } from "@/server/auth/session";
import { buildSchedulingContext } from "./scheduling/buildContext";
import { allocate } from "./scheduling/scoring";
import { eligibilityCheck } from "./scheduling/eligibility";
import type {
  AllocationPlan,
  AssignmentType,
  SchedulingContext,
} from "./scheduling/types";

export interface GenerateResult {
  weekId: string;
  regenerated: boolean;
  plan: AllocationPlan;
  inserted: number;
}

/** Full slot plan without writing anything (§6 preview). */
export async function previewSchedule(weekId: string): Promise<AllocationPlan & { week: { id: string; year: number; isoWeekNumber: number; status: string } }> {
  const db = getDb();
  const w = await db.select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
  const week = w[0];
  if (!week) throw new NotFoundError("week not found");
  const ctx = await buildSchedulingContext(weekId);
  return {
    ...allocate(ctx),
    week: {
      id: week.id,
      year: week.year,
      isoWeekNumber: week.isoWeekNumber,
      status: week.status,
    },
  };
}

interface SnapshotRow {
  id: string;
  weekId: string;
  dakoId: string;
  teacherId: string;
  assignmentType: string;
  assignmentSource: string;
  status: string;
  isOverride: boolean;
  overrideReason: string | null;
  assignedAt: Date | string;
  assignedBy: string | null;
  updatedAt: Date | string;
}

function snapshotOf(rows: (typeof assignments.$inferSelect)[]): SnapshotRow[] {
  return rows.map((r) => ({
    id: r.id,
    weekId: r.weekId,
    dakoId: r.dakoId,
    teacherId: r.teacherId,
    assignmentType: r.assignmentType,
    assignmentSource: r.assignmentSource,
    status: r.status,
    isOverride: r.isOverride,
    overrideReason: r.overrideReason,
    assignedAt: r.assignedAt instanceof Date ? r.assignedAt.toISOString() : String(r.assignedAt),
    assignedBy: r.assignedBy,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
  }));
}

/** §3 — freshly computed (never cached) previous-week absence count. */
export async function countPreviousWeekAbsences(weekId: string): Promise<{
  weekId: string;
  count: number;
}> {
  const ctx = await buildSchedulingContext(weekId);
  return { weekId, count: ctx.prevWeekAbsent.size };
}

/** §15 — server-side eligibility check powering override warnings. */
export async function checkEligibility(input: {
  weekId: string;
  dakoId: string;
  teacherId: string;
}): Promise<{
  eligible: boolean;
  violatedRules: string[];
  overrideAllowed: boolean;
}> {
  const ctx = await buildSchedulingContext(input.weekId);
  const teacher = ctx.teachers.find((t) => t.teacherId === input.teacherId);
  if (!teacher) throw new NotFoundError("teacher not found");
  const dakoRow = ctx.dakos.find((d) => d.dakoId === input.dakoId);
  if (!dakoRow) throw new NotFoundError("dako not found");
  const result = eligibilityCheck(teacher, dakoRow, ctx);
  return {
    eligible: result.eligible,
    violatedRules: result.violatedRules,
    overrideAllowed: result.overrideAllowed,
  };
}

/**
 * §13/§14 — generate (or regenerate) the AUTO schedule for a DRAFT week.
 * - Week row is locked FOR UPDATE so concurrent generations serialize.
 * - Existing AUTO assignments are deleted (snapshot audited first).
 * - MANUAL/OVERRIDE assignments and their teachers are preserved.
 * - New AUTO rows are inserted; slot uniqueness is enforced by unique indexes.
 */
export async function generateSchedule(
  weekId: string,
  actor: SessionUser,
): Promise<GenerateResult> {
  return withTransaction(async (tx) => {
    const locked = await tx
      .select()
      .from(weeks)
      .where(eq(weeks.id, weekId))
      .for("update")
      .limit(1);
    const week = locked[0];
    if (!week) throw new NotFoundError("week not found");
    if (week.status !== "DRAFT") {
      throw new ConflictError(
        `schedule generation requires a DRAFT week (week is ${week.status})`,
      );
    }

    const existingAuto = await tx
      .select()
      .from(assignments)
      .where(and(eq(assignments.weekId, weekId), eq(assignments.assignmentSource, "AUTO")));

    const ctx = await buildSchedulingContext(weekId, tx as unknown as Database);

    if (existingAuto.length > 0) {
      // Scoped cascade exception (migration 0003): allow the assignment delete
      // to cascade into assignment_history for THIS transaction only. The GUC
      // is transaction-local (is_local => true) and vanishes on commit/rollback.
      await tx.execute(
        sql`select set_config('pnk.regeneration_cascade', 'on', true)`,
      );
      await tx
        .delete(assignments)
        .where(and(eq(assignments.weekId, weekId), eq(assignments.assignmentSource, "AUTO")));
    }

    const plan = allocate(ctx);

    // Immobile MANUAL/OVERRIDE rows keep their slots; every plan slot with a
    // teacher becomes an AUTO row (AUTO deletions already happened above).
    const rowsToInsert = [];
    const seenTeachers = new Set<string>();
    for (const s of plan.slots) {
      if (s.teacherId === null) continue;
      if (ctx.immovableTeachers.has(s.teacherId) || seenTeachers.has(s.teacherId)) continue;
      seenTeachers.add(s.teacherId);
      rowsToInsert.push({
        weekId,
        dakoId: s.dakoId,
        teacherId: s.teacherId!,
        assignmentType: s.assignmentType,
        assignmentSource: "AUTO" as const,
        status: "ASSIGNED" as const,
        isOverride: false,
        assignedBy: actor.userId,
      });
    }
    if (rowsToInsert.length > 0) {
      await tx.insert(assignments).values(rowsToInsert);
    }

    const regenerated = existingAuto.length > 0;
    await audit(
      {
        user: actor,
        action: regenerated ? "REGENERATED_SCHEDULE" : "GENERATED_SCHEDULE",
        entityType: "week",
        entityId: weekId,
        oldValue: regenerated
          ? {
              week: { id: week.id, year: week.year, isoWeekNumber: week.isoWeekNumber, status: week.status },
              previousAutoAssignments: snapshotOf(existingAuto),
            }
          : null,
        newValue: {
          week: { id: week.id, year: week.year, isoWeekNumber: week.isoWeekNumber, status: week.status },
          plan,
          inserted: rowsToInsert.length,
        },
        reason: null,
      },
      tx as unknown as Database,
    );

    return { weekId, regenerated, plan, inserted: rowsToInsert.length };
  });
}
