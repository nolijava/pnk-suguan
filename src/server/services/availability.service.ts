import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import {
  teacherAvailability,
  weeks,
  teachers,
  dako,
  auditLogs,
} from "@/server/db/schema";
import {
  availabilityUpsertSchema,
  availabilityBulkSchema,
  type AvailabilityUpsertInput,
} from "@/lib/validation/schemas";
import { NotFoundError, ValidationError, ConflictError, ForbiddenError } from "@/lib/errors";
import { audit } from "./audit.service";
import type { SessionUser } from "@/server/auth/session";
import { isoWeek, isoWeekStart } from "@/lib/iso-week";

/**
 * Effective-status precedence (Phase 3 §8) — the single authoritative resolver:
 *   MASTER INACTIVE > WEEKLY INACTIVE > WEEKLY ABSENT > WEEKLY AVAILABLE
 * No weekly record (and master-ACTIVE) resolves to NOT_ENCODED, which is NOT a
 * scheduling candidate. Master-INACTIVE always wins regardless of any weekly row.
 */
export type EffectiveAvailabilityStatus =
  | "AVAILABLE"
  | "ABSENT"
  | "INACTIVE_WEEKLY"
  | "INACTIVE_MASTER"
  | "NOT_ENCODED";

export function resolveEffectiveStatus(
  weeklyStatus: string | null | undefined,
  masterStatus: string,
): EffectiveAvailabilityStatus {
  if (masterStatus === "INACTIVE") return "INACTIVE_MASTER";
  if (!weeklyStatus) return "NOT_ENCODED";
  if (weeklyStatus === "INACTIVE") return "INACTIVE_WEEKLY";
  return weeklyStatus === "AVAILABLE" || weeklyStatus === "ABSENT"
    ? (weeklyStatus as EffectiveAvailabilityStatus)
    : "NOT_ENCODED";
}

// ---------------------------------------------------------------------------
// PUBLISHED-week availability correction (§8b) — authorization-layer only.
// The week stays PUBLISHED the whole time; week status / assertWeekMutable /
// assignment mutability are untouched.
//
// The ACTIVE-GRANT STATE IS DERIVED from the append-only audit trail: the
// latest UNLOCKED/ENDED correction audit row for the week decides. This is
// correct across Next.js route bundles (no shared module state), survives
// server restarts, and needs no schema change. Grants are SUPER_ADMIN-scoped
// with a 30-minute TTL (measured from the audit row's timestamp).
// ---------------------------------------------------------------------------

interface CorrectionGrant {
  weekId: string;
  /** Grant holder's user id (the SUPER_ADMIN who opened the window). */
  adminId: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
}

/** Server-side TTL. Defaults to 30 minutes; overridable for deterministic expiry tests. */
function correctionTtlMs(): number {
  const raw = Number(process.env.PNK_AVAILABILITY_CORRECTION_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 60 * 1000;
}
const CORRECTION_ACTIONS = ["UNLOCKED_AVAILABILITY_CORRECTION", "ENDED_AVAILABILITY_CORRECTION"] as const;

async function activeCorrection(tx: Database | undefined, weekId: string): Promise<CorrectionGrant | null> {
  const db = tx ?? getDb();
  const ttl = correctionTtlMs();
  const rows = await db
    .select({
      action: auditLogs.action,
      userId: auditLogs.userId,
      reason: auditLogs.reason,
      createdAt: auditLogs.createdAt,
      // ONE CLOCK DOMAIN: the TTL verdict is decided BY POSTGRESQL, which
      // compares its own clock_timestamp() against the audit row's DB-authored
      // created_at. Node's Date.now() is never compared with a database
      // timestamp — the PostgreSQL and Node clocks differ by a measured 4–11 ms
      // on this project's clusters, which is enough for a TTL=0 grant to read
      // as "still active" and intermittently authorize a write. `elapsed >= ttl`
      // is exactly `created_at + ttl <= now`: no grace period, and TTL=0 is
      // deterministically expired (the row was written by an earlier statement,
      // so the elapsed interval is strictly positive).
      expired: sql<boolean>`extract(epoch from (clock_timestamp() - ${auditLogs.createdAt})) * 1000 >= ${ttl}`,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "week"),
        eq(auditLogs.entityId, weekId),
        inArray(auditLogs.action, [...CORRECTION_ACTIONS]),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  const last = rows[0];
  if (!last || last.action !== "UNLOCKED_AVAILABILITY_CORRECTION") return null;
  if (last.expired) return null; // TTL elapsed → locked again (DB-decided, see above)
  const startedAt = last.createdAt;
  // Display value only — derived from the DB-authored start, never used as a
  // gate (the gate is the boolean PostgreSQL computed above).
  const expiresAt = new Date(startedAt.getTime() + ttl);
  return { weekId, adminId: last.userId ?? "", reason: last.reason ?? "", startedAt, expiresAt };
}

export async function isAvailabilityCorrectionActive(weekId: string): Promise<boolean> {
  return (await activeCorrection(undefined, weekId)) !== null;
}

export async function correctionGrantHolder(weekId: string): Promise<string | null> {
  return (await activeCorrection(undefined, weekId))?.adminId ?? null;
}

/**
 * SUPER_ADMIN-only: allow availability corrections on a PUBLISHED week.
 * Requires a reason; audited. Serialized on the week row (FOR UPDATE) so
 * concurrent begin/end/write requests cannot double-open or race the state
 * machine. ADMINISTRATOR, SCHEDULER/ENCODER and VIEWER are refused: the
 * PUBLISHED lock is SUPER_ADMIN-only, mirroring the schedule correction.
 */
export async function beginAvailabilityCorrection(
  weekId: string,
  reason: string,
  actor: SessionUser,
): Promise<{ weekId: string; expiresAt: Date }> {
  if (!actor.roleCodes.includes("SUPER_ADMIN")) {
    throw new ForbiddenError(
      "only SUPER_ADMIN can begin an availability correction on a PUBLISHED week",
    );
  }
  if (!reason || !reason.trim()) {
    throw new ValidationError("reason is required to unlock availability for correction");
  }
  return withTransaction(async (tx) => {
    // Lock the week row: serializes concurrent begin/end transitions.
    const locked = await tx
      .select({ id: weeks.id, status: weeks.status })
      .from(weeks)
      .where(eq(weeks.id, weekId))
      .for("update")
      .limit(1);
    const row = locked[0];
    if (!row) throw new NotFoundError("week not found");
    if (row.status !== "PUBLISHED") {
      throw new ConflictError(`week is ${row.status}; availability correction applies only to PUBLISHED weeks`);
    }
    if (await activeCorrection(tx, weekId)) {
      throw new ConflictError("an availability correction is already active for this week");
    }
    const expiresAt = new Date(Date.now() + correctionTtlMs());
    await audit({
      user: actor,
      action: "UNLOCKED_AVAILABILITY_CORRECTION",
      entityType: "week",
      entityId: weekId,
      oldValue: { status: row.status, availabilityEditable: false },
      newValue: { status: row.status, availabilityEditable: true, correctionsExpireAt: expiresAt.toISOString() },
      reason: reason.trim(),
    }, tx);
    return { weekId, expiresAt };
  });
}

/**
 * SUPER_ADMIN-only: end the correction window; the week returns to locked
 * PUBLISHED. Audited.
 */
export async function endAvailabilityCorrection(weekId: string, actor: SessionUser): Promise<void> {
  if (!actor.roleCodes.includes("SUPER_ADMIN")) {
    throw new ForbiddenError("only SUPER_ADMIN can end an availability correction");
  }
  return withTransaction(async (tx) => {
    const locked = await tx
      .select({ id: weeks.id, status: weeks.status })
      .from(weeks)
      .where(eq(weeks.id, weekId))
      .for("update")
      .limit(1);
    const row = locked[0];
    if (!row) throw new NotFoundError("week not found");
    const grant = await activeCorrection(tx, weekId);
    if (!grant) throw new ConflictError("no availability correction is active for this week");
    await audit({
      user: actor,
      action: "ENDED_AVAILABILITY_CORRECTION",
      entityType: "week",
      entityId: weekId,
      oldValue: { status: row.status, availabilityEditable: true },
      newValue: { status: row.status, availabilityEditable: false },
      reason: grant.reason,
    }, tx);
  });
}

/** PUBLISHED weeks are locked unless a SUPER_ADMIN correction grant covers this actor. */
async function assertAvailabilityEditable(
  week: { id: string; status: string },
  actor: SessionUser,
): Promise<void> {
  if (week.status !== "PUBLISHED") return; // DRAFT and FINALIZED remain editable
  const grant = await activeCorrection(undefined, week.id);
  if (!grant || grant.adminId !== actor.userId) {
    throw new ConflictError(
      "week is PUBLISHED; availability is locked (SUPER_ADMIN correction required)",
    );
  }
}

// ---------------------------------------------------------------------------
// Core upsert
// ---------------------------------------------------------------------------

/** Upsert one weekly availability record (§3/§17). Never touches the teacher profile (§21). */
export async function upsertAvailability(
  input: AvailabilityUpsertInput,
  actor: SessionUser,
): Promise<typeof teacherAvailability.$inferSelect> {
  availabilityUpsertSchema.parse(input);
  return withTransaction(async (tx) => {
    const t = await tx.select().from(teachers).where(eq(teachers.id, input.teacherId)).limit(1);
    if (t.length === 0) throw new NotFoundError("teacher not found");
    const w = await tx.select().from(weeks).where(eq(weeks.id, input.weekId)).limit(1);
    if (w.length === 0) throw new NotFoundError("week not found");
    return applyAvailabilityUpsert(tx, input, actor, t[0]!, w[0]!);
  });
}

/**
 * Shared write path for single upsert, bulk save, and fill-blanks:
 * master-INACTIVE guard, PUBLISHED lock (ADMIN correction), ABSENT-reason
 * requirement, one-row-per-teacher×week, no-op skip, per-change audit.
 */
/** Exported for Phase 6 assignment-clear/replace workflows (same tx only). */
export async function applyAvailabilityUpsert(
  tx: Database,
  input: AvailabilityUpsertInput,
  actor: SessionUser,
  teacher: typeof teachers.$inferSelect,
  week: typeof weeks.$inferSelect,
): Promise<typeof teacherAvailability.$inferSelect> {
  // §14: master status is authoritative — a weekly AVAILABLE/ABSENT value can
  // never make a master-INACTIVE teacher schedulable. Weekly INACTIVE rows may
  // still be recorded for consistency/history.
  if (teacher.status === "INACTIVE" && input.availabilityStatus !== "INACTIVE") {
    throw new ValidationError(
      `teacher ${teacher.teacherCode} is master-INACTIVE; weekly availability cannot override master status`,
    );
  }
  await assertAvailabilityEditable(week, actor);

  if (input.availabilityStatus === "ABSENT" && !input.reason) {
    throw new ValidationError("reason is required when marking a teacher ABSENT");
  }

  const existing = await tx
    .select()
    .from(teacherAvailability)
    .where(
      and(
        eq(teacherAvailability.teacherId, input.teacherId),
        eq(teacherAvailability.weekId, input.weekId),
      ),
    )
    .limit(1);

  const nextValues = {
    availabilityStatus: input.availabilityStatus,
    reason: input.reason ?? null,
    remarks: input.remarks ?? null,
  };

  if (existing.length > 0) {
    const prev = existing[0]!;
    // No-op skip: identical current values produce no rewrite and no audit noise.
    if (
      prev.availabilityStatus === nextValues.availabilityStatus &&
      prev.reason === nextValues.reason &&
      prev.remarks === nextValues.remarks
    ) {
      return prev;
    }
    const updated = await tx
      .update(teacherAvailability)
      .set(nextValues)
      .where(eq(teacherAvailability.id, prev.id))
      .returning();
    const row = updated[0]!;
    await audit(
      {
        user: actor,
        action: "UPSERTED_AVAILABILITY",
        entityType: "teacher_availability",
        entityId: row.id,
        oldValue: prev,
        newValue: row,
        reason: input.reason ?? null,
      },
      tx,
    );
    return row;
  }

  const inserted = await tx
    .insert(teacherAvailability)
    .values({ ...input, reason: nextValues.reason, remarks: nextValues.remarks })
    .returning();
  const row = inserted[0]!;
  await audit(
    {
      user: actor,
      action: "UPSERTED_AVAILABILITY",
      entityType: "teacher_availability",
      entityId: row.id,
      oldValue: null,
      newValue: row,
      reason: input.reason ?? null,
    },
    tx,
  );
  return row;
}

// ---------------------------------------------------------------------------
// Weekly list (single joined query — no N+1) with effective status + filters
// ---------------------------------------------------------------------------

export interface WeeklyAvailabilityRow {
  availabilityId: string | null;
  teacherId: string;
  teacherCode: string;
  fullName: string;
  purokGrupo: string | null;
  language: string;
  currentDestinationId: string | null;
  currentDestinationName: string | null;
  currentDestinationStatus: string | null;
  masterStatus: string;
  weeklyStatus: string | null;
  reason: string | null;
  remarks: string | null;
  effectiveStatus: EffectiveAvailabilityStatus;
}

export type AvailabilityFilter = "AVAILABLE" | "ABSENT" | "INACTIVE_WEEKLY" | "INACTIVE_MASTER" | "NOT_ENCODED";

export async function listWeeklyAvailability(
  weekId: string,
  opts: {
    search?: string;
    availability?: AvailabilityFilter;
    masterStatus?: string;
    language?: string;
    currentDestinationId?: string;
    sort?: "code" | "name";
    order?: "asc" | "desc";
  } = {},
): Promise<{ rows: WeeklyAvailabilityRow[]; total: number }> {
  const w = await getDb().select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
  if (!w[0]) throw new NotFoundError("week not found");

  const conds = [];
  if (opts.search) {
    const like = `%${opts.search}%`;
    conds.push(
      or(
        ilike(teachers.teacherCode, like),
        ilike(teachers.firstName, like),
        ilike(teachers.lastName, like),
        sql`concat_ws(' ', ${teachers.firstName}, ${teachers.middleName}, ${teachers.lastName}) ILIKE ${like}`,
      ),
    );
  }
  if (opts.masterStatus) conds.push(eq(teachers.status, opts.masterStatus));
  if (opts.language) conds.push(eq(teachers.language, opts.language));
  if (opts.currentDestinationId) conds.push(eq(teachers.currentDestinationId, opts.currentDestinationId));
  // Effective-status filters (§10): master-INACTIVE dominates every weekly value.
  if (opts.availability === "AVAILABLE") {
    conds.push(and(eq(teachers.status, "ACTIVE"), eq(teacherAvailability.availabilityStatus, "AVAILABLE"))!);
  } else if (opts.availability === "ABSENT") {
    conds.push(and(eq(teachers.status, "ACTIVE"), eq(teacherAvailability.availabilityStatus, "ABSENT"))!);
  } else if (opts.availability === "INACTIVE_WEEKLY") {
    conds.push(and(eq(teachers.status, "ACTIVE"), eq(teacherAvailability.availabilityStatus, "INACTIVE"))!);
  } else if (opts.availability === "INACTIVE_MASTER") {
    conds.push(eq(teachers.status, "INACTIVE"));
  } else if (opts.availability === "NOT_ENCODED") {
    conds.push(and(eq(teachers.status, "ACTIVE"), isNull(teacherAvailability.id))!);
  }
  const whereClause = conds.length > 0 ? and(...conds) : undefined;

  const fullName = sql<string>`concat_ws(' ', ${teachers.firstName}, ${teachers.middleName}, ${teachers.lastName})`;
  const orderCol = opts.sort === "name" ? fullName : teachers.teacherCode;
  const orderDir = opts.order === "desc" ? desc : asc;

  const rows = await getDb()
    .select({
      availabilityId: teacherAvailability.id,
      teacherId: teachers.id,
      teacherCode: teachers.teacherCode,
      fullName,
      purokGrupo: teachers.purokGrupo,
      language: teachers.language,
      currentDestinationId: teachers.currentDestinationId,
      currentDestinationName: dako.name,
      currentDestinationStatus: dako.status,
      masterStatus: teachers.status,
      weeklyStatus: teacherAvailability.availabilityStatus,
      reason: teacherAvailability.reason,
      remarks: teacherAvailability.remarks,
    })
    .from(teachers)
    .leftJoin(
      teacherAvailability,
      and(
        eq(teacherAvailability.teacherId, teachers.id),
        eq(teacherAvailability.weekId, weekId),
      ),
    )
    .leftJoin(dako, eq(dako.id, teachers.currentDestinationId))
    .where(whereClause)
    .orderBy(orderDir(orderCol))
    .limit(1000);

  const countRows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(teachers)
    .leftJoin(
      teacherAvailability,
      and(
        eq(teacherAvailability.teacherId, teachers.id),
        eq(teacherAvailability.weekId, weekId),
      ),
    )
    .where(whereClause);

  return {
    rows: rows.map((r) => ({ ...r, effectiveStatus: resolveEffectiveStatus(r.weeklyStatus, r.masterStatus) })),
    total: countRows[0]?.n ?? 0,
  };
}

/** The whole availability picture for one teacher in one week (or null). */
export async function getTeacherAvailability(
  teacherId: string,
  weekId: string,
): Promise<WeeklyAvailabilityRow | null> {
  const rows = await getDb()
    .select({
      availabilityId: teacherAvailability.id,
      teacherId: teachers.id,
      teacherCode: teachers.teacherCode,
      fullName: sql<string>`concat_ws(' ', ${teachers.firstName}, ${teachers.middleName}, ${teachers.lastName})`,
      purokGrupo: teachers.purokGrupo,
      language: teachers.language,
      currentDestinationId: teachers.currentDestinationId,
      currentDestinationName: dako.name,
      currentDestinationStatus: dako.status,
      masterStatus: teachers.status,
      weeklyStatus: teacherAvailability.availabilityStatus,
      reason: teacherAvailability.reason,
      remarks: teacherAvailability.remarks,
    })
    .from(teachers)
    .leftJoin(
      teacherAvailability,
      and(
        eq(teacherAvailability.teacherId, teachers.id),
        eq(teacherAvailability.weekId, weekId),
      ),
    )
    .leftJoin(dako, eq(dako.id, teachers.currentDestinationId))
    .where(eq(teachers.id, teacherId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { ...r, effectiveStatus: resolveEffectiveStatus(r.weeklyStatus, r.masterStatus) };
}

// ---------------------------------------------------------------------------
// Previous-week / history lookups (Phase 4 scheduler inputs — §9/§15/§22)
// ---------------------------------------------------------------------------

/** Row for the ISO week immediately before `weekId` (null when none exists). */
export async function getPreviousWeekAvailability(
  teacherId: string,
  weekId: string,
): Promise<WeeklyAvailabilityRow | null> {
  const w = await getDb().select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
  const cur = w[0];
  if (!cur) throw new NotFoundError("week not found");
  const prevStart = new Date(`${cur.startDate}T00:00:00Z`);
  prevStart.setUTCDate(prevStart.getUTCDate() - 7);
  const prev = isoWeek(prevStart);
  const prevWeek = await getDb()
    .select()
    .from(weeks)
    .where(and(eq(weeks.year, prev.year), eq(weeks.isoWeekNumber, prev.week)))
    .limit(1);
  if (!prevWeek[0]) return null;
  return getTeacherAvailability(teacherId, prevWeek[0].id);
}

/** Batch scheduler input: every teacher ABSENT in the week before `weekId`. */
export async function wasAbsentPreviousWeekBatch(weekId: string): Promise<Set<string>> {
  const w = await getDb().select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
  const cur = w[0];
  if (!cur) throw new NotFoundError("week not found");
  const prevStart = new Date(`${cur.startDate}T00:00:00Z`);
  prevStart.setUTCDate(prevStart.getUTCDate() - 7);
  const prev = isoWeek(prevStart);
  const rows = await getDb()
    .select({ teacherId: teacherAvailability.teacherId })
    .from(teacherAvailability)
    .innerJoin(weeks, eq(weeks.id, teacherAvailability.weekId))
    .where(
      and(
        eq(teacherAvailability.availabilityStatus, "ABSENT"),
        eq(weeks.year, prev.year),
        eq(weeks.isoWeekNumber, prev.week),
      ),
    );
  return new Set(rows.map((r) => r.teacherId));
}

/** Historical weekly availability for one teacher (most recent first). */
export async function getAvailabilityHistory(teacherId: string, limit = 52) {
  return getDb()
    .select({
      weekId: weeks.id,
      year: weeks.year,
      isoWeekNumber: weeks.isoWeekNumber,
      weekStatus: weeks.status,
      startDate: weeks.startDate,
      endDate: weeks.endDate,
      availabilityStatus: teacherAvailability.availabilityStatus,
      reason: teacherAvailability.reason,
      remarks: teacherAvailability.remarks,
      updatedAt: teacherAvailability.updatedAt,
    })
    .from(teacherAvailability)
    .innerJoin(weeks, eq(weeks.id, teacherAvailability.weekId))
    .where(eq(teacherAvailability.teacherId, teacherId))
    .orderBy(desc(weeks.startDate))
    .limit(Math.min(200, Math.max(1, limit)));
}

// ---------------------------------------------------------------------------
// Bulk save (§11) — one transaction, per-row validation, per-row audit
// ---------------------------------------------------------------------------

export async function bulkSetAvailability(
  payload: { changes: AvailabilityUpsertInput[] },
  actor: SessionUser,
): Promise<{ saved: number; skipped: number; weekId: string }> {
  const { changes } = availabilityBulkSchema.parse(payload);
  const weekIds = new Set(changes.map((c) => c.weekId));
  if (weekIds.size !== 1) {
    throw new ValidationError("bulk save must target a single week");
  }
  const weekId = changes[0]!.weekId;
  return withTransaction(async (tx) => {
    const w = await tx.select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
    if (!w[0]) throw new NotFoundError("week not found");
    const week = w[0];
    await assertAvailabilityEditable(week, actor);

    let saved = 0;
    let skipped = 0;
    for (let i = 0; i < changes.length; i++) {
      const parsed = availabilityUpsertSchema.parse(changes[i]);
      const t = await tx.select().from(teachers).where(eq(teachers.id, parsed.teacherId)).limit(1);
      if (!t[0]) throw new ValidationError(`row ${i + 1}: teacher not found`);
      try {
        const before = await tx
          .select()
          .from(teacherAvailability)
          .where(
            and(
              eq(teacherAvailability.teacherId, parsed.teacherId),
              eq(teacherAvailability.weekId, weekId),
            ),
          )
          .limit(1);
        const row = await applyAvailabilityUpsert(tx, parsed, actor, t[0]!, week);
        const isNoop =
          before.length > 0 &&
          before[0]!.availabilityStatus === row.availabilityStatus &&
          before[0]!.reason === row.reason &&
          before[0]!.remarks === row.remarks &&
          before[0]!.updatedAt.getTime() === row.updatedAt.getTime();
        if (isNoop) skipped++;
        else saved++;
      } catch (err) {
        if (err instanceof ValidationError) {
          throw new ValidationError(`row ${i + 1}: ${err.message}`);
        }
        throw err;
      }
    }
    return { saved, skipped, weekId };
  });
}

// ---------------------------------------------------------------------------
// Fill Blanks as AVAILABLE (§11 refinement 3)
// Targets ONLY master-ACTIVE teachers with NO record for the week; never
// overwrites existing records; never creates rows for master-INACTIVE teachers.
// ---------------------------------------------------------------------------

export async function fillBlanksAsAvailable(
  weekId: string,
  actor: SessionUser,
): Promise<{ created: number; skipped: number; weekId: string }> {
  return withTransaction(async (tx) => {
    const w = await tx.select().from(weeks).where(eq(weeks.id, weekId)).limit(1);
    if (!w[0]) throw new NotFoundError("week not found");
    const week = w[0];
    await assertAvailabilityEditable(week, actor);

    const targets = await tx
      .select({ id: teachers.id, teacherCode: teachers.teacherCode })
      .from(teachers)
      .leftJoin(
        teacherAvailability,
        and(
          eq(teacherAvailability.teacherId, teachers.id),
          eq(teacherAvailability.weekId, weekId),
        ),
      )
      .where(and(eq(teachers.status, "ACTIVE"), isNull(teacherAvailability.id)));

    for (const t of targets) {
      await applyAvailabilityUpsert(
        tx,
        { teacherId: t.id, weekId, availabilityStatus: "AVAILABLE" },
        actor,
        { ...t, status: "ACTIVE" } as typeof teachers.$inferSelect,
        week,
      );
    }
    return { created: targets.length, skipped: 0, weekId };
  });
}

/** Count of teachers Fill Blanks would target (for the UI confirmation dialog). */
export async function countFillBlankTargets(weekId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(teachers)
    .leftJoin(
      teacherAvailability,
      and(
        eq(teacherAvailability.teacherId, teachers.id),
        eq(teacherAvailability.weekId, weekId),
      ),
    )
    .where(and(eq(teachers.status, "ACTIVE"), isNull(teacherAvailability.id)));
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Phase 1 API preserved below (reused by earlier tests/routes)
// ---------------------------------------------------------------------------

export async function listAvailabilityForWeek(weekId: string) {
  return getDb()
    .select({
      id: teacherAvailability.id,
      teacherId: teacherAvailability.teacherId,
      availabilityStatus: teacherAvailability.availabilityStatus,
      reason: teacherAvailability.reason,
      remarks: teacherAvailability.remarks,
    })
    .from(teacherAvailability)
    .where(eq(teacherAvailability.weekId, weekId));
}

/** §18: was the teacher absent in the ISO week before `year/week`? (scheduler input) */
export async function wasAbsentPreviousWeek(
  teacherId: string,
  year: number,
  isoWeekNumber: number,
): Promise<boolean> {
  // Previous ISO week via date arithmetic — handles year wrap (week 1 → 52/53).
  const prevStart = new Date(isoWeekStart(year, isoWeekNumber));
  prevStart.setUTCDate(prevStart.getUTCDate() - 7);
  const prev = isoWeek(prevStart);
  const rows = await getDb()
    .select({ id: teacherAvailability.id })
    .from(teacherAvailability)
    .innerJoin(weeks, eq(weeks.id, teacherAvailability.weekId))
    .where(
      and(
        eq(teacherAvailability.teacherId, teacherId),
        eq(teacherAvailability.availabilityStatus, "ABSENT"),
        eq(weeks.year, prev.year),
        eq(weeks.isoWeekNumber, prev.week),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function latestAvailabilityForTeacher(teacherId: string, limit = 10) {
  return getDb()
    .select({
      year: weeks.year,
      isoWeekNumber: weeks.isoWeekNumber,
      availabilityStatus: teacherAvailability.availabilityStatus,
      reason: teacherAvailability.reason,
    })
    .from(teacherAvailability)
    .innerJoin(weeks, eq(weeks.id, teacherAvailability.weekId))
    .where(eq(teacherAvailability.teacherId, teacherId))
    .orderBy(desc(weeks.startDate))
    .limit(limit);
}
