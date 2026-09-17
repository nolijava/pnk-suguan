import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import {
  assignments,
  assignmentHistory,
  teacherAvailability,
  teachers,
  dako,
  weeks,
} from "@/server/db/schema";
import { assignmentCreateSchema, type AssignmentCreateInput } from "@/lib/validation/schemas";
import { isTeacherEligibleForDako, isNonOverrideableRule, type Language } from "@/lib/eligibility";
import { ForbiddenError, ValidationError, NotFoundError, ConflictError } from "@/lib/errors";
import { audit } from "./audit.service";
import { assertWeekMutable } from "./week.service";
import { wasAbsentPreviousWeekBatch } from "./availability.service";
import type { SessionUser } from "@/server/auth/session";

export interface CreateAssignmentResult {
  assignment: typeof assignments.$inferSelect;
  override: boolean;
}

/**
 * Create one assignment (manual/auto). Enforces:
 *  - week must be DRAFT (mutable);
 *  - one assignment per teacher per week (unique + explicit check);
 *  - one slot per dako+type per week (unique);
 *  - language eligibility (§22) unless explicitly overridden with a reason;
 *  - dako and teacher must be ACTIVE for normal assignment;
 *  - full history trail via trigger + audit entry.
 */
export async function createAssignment(
  input: AssignmentCreateInput,
  actor: SessionUser,
): Promise<CreateAssignmentResult> {
  assignmentCreateSchema.parse(input);
  const isOverride = Boolean(input.overrideReason);
  if (isOverride && !actor.roleCodes.includes("ADMIN")) {
    // Only ADMIN may bypass the eligibility/lifecycle rules (§7).
    // SCHEDULER may still write normal assignments and may fill an empty slot.
    if (!canOverride(actor)) {
      throw new ValidationError("override requires an administrator");
    }
  }

  return withTransaction(async (tx) => {
    await assertWeekMutable(tx, input.weekId);

    const tRow = await tx.select().from(teachers).where(eq(teachers.id, input.teacherId)).limit(1);
    const t = tRow[0];
    if (!t) throw new NotFoundError("teacher not found");
    const dRow = await tx.select().from(dako).where(eq(dako.id, input.dakoId)).limit(1);
    const d = dRow[0];
    if (!d) throw new NotFoundError("dako not found");

    if (!isOverride) {
      if (t.status !== "ACTIVE") throw new ConflictError(`teacher is ${t.status}`);
    }

    // Phase 5 — NON-overrideable hard rules: rejected for EVERY actor, with or
    // without an override reason (§14: English dako accepts English teachers
    // only; the sole path to eligibility is editing the teacher profile).
    // DAKO_DISABLED was already documented as structural — the gate closes the
    // latent create-path gap. Everything else keeps the ADMIN-override flow.
    if (d.status !== "ACTIVE") {
      throw new ConflictError(`dako is ${d.status}`);
    }
    if (!isTeacherEligibleForDako(t.language as Language, d.language as Language)) {
      throw new ConflictError(
        `FILIPINO teacher cannot serve ENGLISH dako — not overridable (change the teacher's language to ENGLISH in their profile)`,
      );
    }

    // Duplicate slot check (friendly error before hitting the unique index).
    const slot = await tx
      .select({ id: assignments.id })
      .from(assignments)
      .where(
        and(
          eq(assignments.weekId, input.weekId),
          eq(assignments.dakoId, input.dakoId),
          eq(assignments.assignmentType, input.assignmentType),
        ),
      )
      .limit(1);
    if (slot.length > 0) {
      throw new ConflictError(`${input.assignmentType} slot for this dako this week is already filled`);
    }

    // One assignment per teacher per week (§21) — explicit check for a clear message.
    const existing = await tx
      .select({ id: assignments.id })
      .from(assignments)
      .where(
        and(eq(assignments.weekId, input.weekId), eq(assignments.teacherId, input.teacherId)),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictError("teacher already has an assignment this week");
    }

    const inserted = await tx
      .insert(assignments)
      .values({
        weekId: input.weekId,
        dakoId: input.dakoId,
        teacherId: input.teacherId,
        assignmentType: input.assignmentType,
        assignmentSource: isOverride ? "OVERRIDE" : "MANUAL",
        isOverride,
        overrideReason: input.overrideReason ?? null,
        assignedBy: actor.userId,
      })
      .returning();
    const row = inserted[0]!;

    await audit(
      {
        user: actor,
        action: isOverride ? "OVERRIDING_ASSIGNMENT_RULE" : "CREATED_ASSIGNMENT",
        entityType: "assignment",
        entityId: row.id,
        oldValue: null,
        newValue: row,
        reason: input.overrideReason ?? null,
      },
      tx as Database,
    );

    return { assignment: row, override: isOverride };
  });
}

function canOverride(actor: SessionUser): boolean {
  return actor.roleCodes.includes("ADMIN");
}

/**
 * §15 — compute which hard eligibility rules the PROPOSED (teacher, dako, week)
 * would violate. Mirrors the engine's hard rules so a manual override can never
 * silently bypass a rule: the caller sees exactly what is being overridden.
 */
async function violatedRulesFor(
  tx: Database,
  weekId: string,
  dakoId: string,
  teacherId: string,
  currentAssignmentId?: string,
): Promise<string[]> {
  const [tRow] = await tx.select().from(teachers).where(eq(teachers.id, teacherId)).limit(1);
  const [dRow] = await tx.select().from(dako).where(eq(dako.id, dakoId)).limit(1);
  if (!tRow) throw new NotFoundError("teacher not found");
  if (!dRow) throw new NotFoundError("dako not found");

  const [wRow] = await tx.select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
  if (!wRow) throw new NotFoundError("week not found");

  const violated: string[] = [];
  if (tRow.status !== "ACTIVE") violated.push("TEACHER_INACTIVE_MASTER");
  if (dRow.status !== "ACTIVE") violated.push("DAKO_DISABLED");

  const [avail] = await tx
    .select({ status: teacherAvailability.availabilityStatus })
    .from(teacherAvailability)
    .where(and(eq(teacherAvailability.teacherId, teacherId), eq(teacherAvailability.weekId, weekId)))
    .limit(1);
  if (!avail) violated.push("NOT_ENCODED");
  else if (avail.status === "ABSENT") violated.push("WEEKLY_ABSENT");
  else if (avail.status === "INACTIVE") violated.push("WEEKLY_INACTIVE");
  else if (avail.status !== "AVAILABLE") violated.push("NOT_ENCODED");

  // Previous-week ABSENT — hard for the engine; overrideable by ADMIN (§5/§15).
  const prevAbsent = await wasAbsentPreviousWeekBatch(weekId);
  if (prevAbsent.has(teacherId)) violated.push("PREVIOUS_WEEK_ABSENT");

  if (!isTeacherEligibleForDako(tRow.language as Language, dRow.language as Language)) {
    violated.push("LANGUAGE_MISMATCH");
  }

  // Already-assigned is a structural constraint, not an eligibility rule:
  // the unique indexes reject it for everyone (no override path).
  // NOTE: DAKO_DISABLED + LANGUAGE_MISMATCH here are NON-overrideable
  // (see NON_OVERRIDEABLE_RULES) — callers must reject them outright.
  const dup = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.weekId, weekId), eq(assignments.teacherId, teacherId)))
    .limit(1);
  if (dup.length > 0 && dup[0]!.id !== currentAssignmentId) violated.push("ALREADY_ASSIGNED_THIS_WEEK");

  return violated;
}

/** Change an existing assignment (swap teacher/type/status). Writes history row + audit. */
export async function changeAssignment(
  id: string,
  input: { teacherId?: string; assignmentType?: string; reason: string },
  actor: SessionUser,
): Promise<typeof assignments.$inferSelect> {
  return withTransaction(async (tx) => {
    const before = (await tx.select().from(assignments).where(eq(assignments.id, id)).limit(1))[0];
    if (!before) throw new NotFoundError("assignment not found");
    await assertWeekMutable(tx, before.weekId);

    // §15 — if the PROPOSED state violates a hard eligibility rule, only ADMIN
    // may proceed, and the reason must state the override (mandatory, non-empty;
    // already enforced by the Zod schema min(1)).
    let violated: string[] = [];
    if (input.teacherId) {
      violated = await violatedRulesFor(tx, before.weekId, before.dakoId, input.teacherId, id);
      // Phase 5 — non-overrideable rules (e.g. LANGUAGE_MISMATCH) reject
      // EVERY actor, ADMIN included; no reason can bypass them.
      const structural = violated.filter(isNonOverrideableRule);
      if (structural.length > 0) {
        throw new ConflictError(
          `assignment change violates non-overrideable rule(s): ${structural.join(", ")} — cannot be overridden (fix master data, e.g. teacher language)`,
        );
      }
      if (violated.length > 0 && !canOverride(actor)) {
        throw new ForbiddenError(
          `assignment change violates hard rule(s): ${violated.join(", ")} — override requires an administrator with a reason`,
        );
      }
    }

    const patch: Partial<typeof assignments.$inferInsert> = {
      isOverride: true,
      overrideReason: input.reason.replace(/^\[RULES:[^\]]*\]\s*/, ""),
      assignmentSource: "OVERRIDE",
      assignedBy: actor.userId,
    };
    if (input.teacherId) {
      const tRow = await tx.select().from(teachers).where(eq(teachers.id, input.teacherId)).limit(1);
      if (!tRow[0]) throw new NotFoundError("teacher not found");
      const dup = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.weekId, before.weekId), eq(assignments.teacherId, input.teacherId)))
        .limit(1);
      if (dup.length > 0 && dup[0]!.id !== id) {
        throw new ConflictError("replacement teacher already has an assignment this week");
      }
      patch.teacherId = input.teacherId;
    }
    if (input.assignmentType) {
      const slot = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          and(
            eq(assignments.weekId, before.weekId),
            eq(assignments.dakoId, before.dakoId),
            eq(assignments.assignmentType, input.assignmentType),
          ),
        )
        .limit(1);
      if (slot.length > 0 && slot[0]!.id !== id) {
        throw new ConflictError(`${input.assignmentType} slot for this dako this week is already filled`);
      }
      patch.assignmentType = input.assignmentType;
    }

    const updated = await tx.update(assignments).set(patch).where(eq(assignments.id, id)).returning();
    const row = updated[0]!;

    // The client may already prefix violated rules; the service owns the
    // canonical prefix — strip any client copy, then prepend once.
    const clientPrefix = input.reason.match(/^\[RULES:[^\]]*\]\s*/);
    const bareReason = clientPrefix ? input.reason.slice(clientPrefix[0].length) : input.reason;

    await audit(
      {
        user: actor,
        action: violated.length > 0 ? "MANUAL_ASSIGNMENT_OVERRIDE" : "CHANGED_ASSIGNMENT",
        entityType: "assignment",
        entityId: id,
        oldValue: before,
        newValue: row,
        reason:
          violated.length > 0
            ? `[RULES: ${violated.join(", ")}] ${bareReason}`
            : bareReason,
      },
      tx as Database,
    );

    return row;
  });
}

export async function getAssignment(id: string) {
  const rows = await getDb().select().from(assignments).where(eq(assignments.id, id)).limit(1);
  if (rows.length === 0) throw new NotFoundError("assignment not found");
  return rows[0];
}

/**
 * Phase 5 — batched annual schedule query (§20/§21): EVERY assignment in an
 * ISO year in ONE join, no per-week/per-cell requests. Read-only — viewing the
 * annual tables never creates weeks or rows. Disabled dakos remain visible
 * for weeks where they hold historical assignments (§6).
 */
export async function listAssignmentsForYear(year: number) {
  return getDb()
    .select({
      id: assignments.id,
      weekId: assignments.weekId,
      weekNumber: weeks.isoWeekNumber,
      dakoId: assignments.dakoId,
      dakoCode: dako.dakoCode,
      dakoName: dako.name,
      dakoStatus: dako.status,
      assignmentType: assignments.assignmentType,
      assignmentSource: assignments.assignmentSource,
      status: assignments.status,
      teacherId: assignments.teacherId,
      teacherCode: teachers.teacherCode,
      teacherName: sql<string>`trim(concat(${teachers.firstName}, ' ', coalesce(${teachers.middleName}, ''), ' ', ${teachers.lastName}))`,
    })
    .from(assignments)
    .innerJoin(weeks, eq(weeks.id, assignments.weekId))
    .innerJoin(dako, eq(dako.id, assignments.dakoId))
    .innerJoin(teachers, eq(teachers.id, assignments.teacherId))
    .where(eq(weeks.year, year))
    .orderBy(weeks.isoWeekNumber, dako.dakoCode, assignments.assignmentType);
}

export async function listAssignmentsForWeek(weekId: string) {
  return getDb()
    .select({
      id: assignments.id,
      dakoId: assignments.dakoId,
      dakoName: dako.name,
      teacherId: assignments.teacherId,
      teacherName: sql<string>`concat(${teachers.firstName}, ' ', ${teachers.lastName})`,
      assignmentType: assignments.assignmentType,
      status: assignments.status,
      isOverride: assignments.isOverride,
    })
    .from(assignments)
    .innerJoin(dako, eq(dako.id, assignments.dakoId))
    .innerJoin(teachers, eq(teachers.id, assignments.teacherId))
    .where(eq(assignments.weekId, weekId))
    .orderBy(dako.name, assignments.assignmentType);
}

export async function getAssignmentHistory(assignmentId: string) {
  return getDb()
    .select()
    .from(assignmentHistory)
    .where(eq(assignmentHistory.assignmentId, assignmentId))
    .orderBy(assignmentHistory.changedAt);
}

/** §35 scheduler input: counts per teacher×dako×type from the counting view. */
export async function getAssignmentCounts(opts: {
  teacherId?: string;
  dakoId?: string;
  assignmentType?: string;
  limit?: number;
} = {}) {
  const conditions = [];
  if (opts.teacherId) conditions.push(eq(assignments.teacherId, opts.teacherId));
  if (opts.dakoId) conditions.push(eq(assignments.dakoId, opts.dakoId));
  if (opts.assignmentType) conditions.push(eq(assignments.assignmentType, opts.assignmentType));
  const base = getDb()
    .select({
      teacherId: assignments.teacherId,
      dakoId: assignments.dakoId,
      assignmentType: assignments.assignmentType,
      total: sql<number>`count(*)::int`,
      yearTotal: sql<number>`count(*) filter (where ${weeks.year} = date_part('year', now())::int)::int`,
      lastAssignedAt: sql<Date | null>`max(${assignments.assignedAt})`,
    })
    .from(assignments)
    .innerJoin(weeks, eq(weeks.id, assignments.weekId))
    .where(eq(assignments.status, "ASSIGNED"))
    .groupBy(assignments.teacherId, assignments.dakoId, assignments.assignmentType);
  const rows = await getDb()
    .select({
      teacherId: assignments.teacherId,
      dakoId: assignments.dakoId,
      assignmentType: assignments.assignmentType,
      total: sql<number>`count(*)::int`,
      yearTotal: sql<number>`count(*) filter (where ${weeks.year} = date_part('year', now())::int)::int`,
      lastAssignedAt: sql<Date | null>`max(${assignments.assignedAt})`,
    })
    .from(assignments)
    .innerJoin(weeks, eq(weeks.id, assignments.weekId))
    .where(
      conditions.length > 0
        ? and(eq(assignments.status, "ASSIGNED"), ...conditions)
        : eq(assignments.status, "ASSIGNED"),
    )
    .groupBy(assignments.teacherId, assignments.dakoId, assignments.assignmentType)
    .orderBy(assignments.teacherId, assignments.dakoId)
    .limit(opts.limit ?? 10000);
  return rows;
}

/** Recent assignments per teacher (for balancing heuristics later). */
export async function recentAssignmentsForTeacher(teacherId: string, limit = 10) {
  return getDb()
    .select({
      id: assignments.id,
      year: weeks.year,
      isoWeekNumber: weeks.isoWeekNumber,
      dakoId: assignments.dakoId,
      dakoName: dako.name,
      assignmentType: assignments.assignmentType,
      assignedAt: assignments.assignedAt,
    })
    .from(assignments)
    .innerJoin(weeks, eq(weeks.id, assignments.weekId))
    .innerJoin(dako, eq(dako.id, assignments.dakoId))
    .where(eq(assignments.teacherId, teacherId))
    .orderBy(sql`${assignments.assignedAt} desc`)
    .limit(limit);
}

// keep gte imported for future range queries in tests
void gte;
