/**
 * Phase 4 — transactional scheduling service (§13/§14/§18).
 *
 * Generation is DRAFT-only, transaction-serialized on the week row, and
 * idempotent: AUTO assignments are replaced; MANUAL/OVERRIDE assignments are
 * preserved untouched. The complete previous AUTO set is snapshotted into the
 * REGENERATED_SCHEDULE audit row so history stays reconstructable even though
 * deleted rows cascade their assignment_history children.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import {
  assignments,
  auditLogs,
  dako,
  teachers,
  weeks,
} from "@/server/db/schema";
import { ValidationError, NotFoundError, ConflictError } from "@/lib/errors";
import { isNormalSchedulingWeek, SCHEDULING_GO_LIVE } from "@/server/config";
import { HistoricalWeekError } from "./historical.service";
import { audit } from "./audit.service";
import type { SessionUser } from "@/server/auth/session";
import { buildSchedulingContext } from "./scheduling/buildContext";
import { allocate } from "./scheduling/scoring";
import { eligibilityCheck } from "./scheduling/eligibility";
import {
  planDutyAssignments,
  type DutyMode,
  type DutyPlan,
  type DutyRotationStats,
} from "./scheduling/duty";
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

export interface DutyGenerateResult {
  weekId: string;
  mode: DutyMode;
  regenerated: boolean;
  plan: DutyPlan;
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
 * Guro Duty — generate (or regenerate) the duty-based schedule for a DRAFT
 * week. Same lifecycle/guard rails as §13/§14 generateSchedule (week locked
 * FOR UPDATE, go-live check, DRAFT-only) but the slot plan comes from each
 * dako's own duty roster with deterministic fair rotation. Replaces only
 * generation-produced rows (AUTO) on the APPLICABLE dakos; MANUAL/OVERRIDE
 * rows survive untouched. The week ALWAYS remains DRAFT.
 */
export async function generateDutySchedule(
  weekId: string,
  mode: DutyMode,
  actor: SessionUser,
): Promise<DutyGenerateResult> {
  return withTransaction(async (tx) => {
    const locked = await tx
      .select()
      .from(weeks)
      .where(eq(weeks.id, weekId))
      .for("update")
      .limit(1);
    const week = locked[0];
    if (!week) throw new NotFoundError("week not found");
    if (!isNormalSchedulingWeek(week.year, week.isoWeekNumber)) {
      throw new HistoricalWeekError(
        `week ${week.year}-W${week.isoWeekNumber} is before the scheduling go-live ` +
          `(${SCHEDULING_GO_LIVE.year}-W${SCHEDULING_GO_LIVE.week}); historical weeks are recorded via the Historical Backfill workflow only`,
      );
    }
    if (week.status !== "DRAFT") {
      throw new ConflictError(
        `schedule generation requires a DRAFT week (week is ${week.status})`,
      );
    }

    const ctx = await buildSchedulingContext(weekId, tx as unknown as Database);

    // Fair-rotation history for THIS mode (all weeks, per teacher × dako) —
    // what makes the rotation fair AND reconstructable (#7).
    const statRows = await tx
      .select({
        teacherId: assignments.teacherId,
        dakoId: assignments.dakoId,
        sugoPicks: sql<number>`count(*) filter (where ${assignments.assignmentType} = 'SUGO')::int`,
        reserbaPicks: sql<number>`count(*) filter (where ${assignments.assignmentType} = 'RESERBA')::int`,
        reserbaIiPicks: sql<number>`count(*) filter (where ${assignments.assignmentType} = 'RESERBA_II')::int`,
        lastPickedAt: sql<string | null>`max(${assignments.assignedAt})::text`,
      })
      .from(assignments)
      .where(and(eq(assignments.generationMode, mode), eq(assignments.status, "ASSIGNED")))
      .groupBy(assignments.teacherId, assignments.dakoId);
    const rotation = new Map<string, DutyRotationStats>();
    for (const r of statRows) {
      rotation.set(`${r.teacherId}|${r.dakoId}`, {
        sugoPicks: r.sugoPicks,
        reserbaPicks: r.reserbaPicks,
        reserbaIiPicks: r.reserbaIiPicks,
        lastPickedAt: r.lastPickedAt,
      });
    }

    const plan = planDutyAssignments(ctx, mode, rotation);

    // Replace generation-produced rows (AUTO) inside the APPLICABLE dakos
    // only. Snapshot first so regeneration stays fully audited.
    const plannedDakoIds = [...new Set(plan.slots.map((s) => s.dakoId))];
    const existingAuto =
      plannedDakoIds.length > 0
        ? await tx
            .select()
            .from(assignments)
            .where(
              and(
                eq(assignments.weekId, weekId),
                eq(assignments.assignmentSource, "AUTO"),
                inArray(assignments.dakoId, plannedDakoIds),
              ),
            )
        : [];
    if (existingAuto.length > 0) {
      await tx.execute(sql`select set_config('pnk.regeneration_cascade', 'on', true)`);
      await tx
        .delete(assignments)
        .where(
          and(
            eq(assignments.weekId, weekId),
            eq(assignments.assignmentSource, "AUTO"),
            inArray(assignments.dakoId, plannedDakoIds),
          ),
        );
    }

    const rowsToInsert = [];
    for (const s of plan.slots) {
      if (s.teacherId === null) continue;
      rowsToInsert.push({
        weekId,
        dakoId: s.dakoId,
        teacherId: s.teacherId,
        assignmentType: s.assignmentType,
        assignmentSource: "AUTO" as const,
        status: "ASSIGNED" as const,
        isOverride: false,
        assignedBy: actor.userId,
        generationMode: mode,
      });
    }
    if (rowsToInsert.length > 0) {
      await tx.insert(assignments).values(rowsToInsert);
    }

    const regenerated = existingAuto.length > 0;
    await audit(
      {
        user: actor,
        action: "GENERATED_DUTY_SCHEDULE",
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
          role: (actor as SessionUser & { roleCodes?: string[] }).roleCodes ?? [],
          generationMode: mode,
          inserted: rowsToInsert.length,
          // Full per-slot decision trail (dako, teacher, duty, type, source,
          // rotation stats) — the fair-rotation outcome is reconstructable.
          plan: plan.slots,
        },
        reason: `mode=${mode}`,
      },
      tx as unknown as Database,
    );

    return { weekId, mode, regenerated, plan, inserted: rowsToInsert.length };
  });
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
    // Master plan E-4 — server-side workflow separation: pre-go-live weeks are
    // HISTORICAL-only and can never be processed by automatic generation
    // (source exclusivity; not just a UI filter).
    if (!isNormalSchedulingWeek(week.year, week.isoWeekNumber)) {
      throw new HistoricalWeekError(
        `week ${week.year}-W${week.isoWeekNumber} is before the scheduling go-live ` +
          `(${SCHEDULING_GO_LIVE.year}-W${SCHEDULING_GO_LIVE.week}); historical weeks are recorded via the Historical Backfill workflow only`,
      );
    }
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
