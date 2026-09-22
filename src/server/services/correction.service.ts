/**
 * Master Consolidated Plan E-1/E-2 — schedule correction architecture.
 *
 * Two gateways over the SAME audit-derived, TTL-scoped grant mechanism proven
 * in the Phase 3 availability correction (audit trail decides the active
 * state; week status column is never written; single grant holder; row-locked
 * transitions):
 *
 *   • FINALIZED weeks — authorized correction (Invariant 6). Any holder of
 *     `weeks.unlock` — ADMIN, SUPER_ADMIN, SCHEDULER/ENCODER. Audited
 *     FINALIZED_SCHEDULE_UNLOCKED / FINALIZED_CORRECTION_ENDED. The week
 *     REMAINS FINALIZED throughout; nothing requires reverting to DRAFT.
 *
 *   • PUBLISHED weeks — SUPER_ADMIN emergency unlock (§24). Requires the
 *     server-verified super-admin secret (env, timing-safe compared, never
 *     logged/returned/stored client-side; absent env fails closed). Audited
 *     PUBLISHED_SCHEDULE_UNLOCKED / PUBLISHED_CORRECTION_ENDED. Scoped to the
 *     single week; TTL re-lock; the week REMAINS PUBLISHED throughout — no
 *     status downgrade, no global unlock.
 *
 * In every state, LANGUAGE_MISMATCH and DAKO_DISABLED stay non-overrideable
 * (checked in assignment validation BEFORE grant consideration).
 *
 * `assertScheduleCorrectable` replaces the hard DRAFT-only gate for
 * assignment mutations: DRAFT → open; FINALIZED/PUBLISHED → require an
 * active grant held by the caller. `assertWeekMutable` (DRAFT-only) remains
 * untouched and continues to guard generation/regeneration.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import { auditLogs, weeks } from "@/server/db/schema";
import { audit } from "./audit.service";
import { ForbiddenError, NotFoundError, ConflictError, ValidationError } from "@/lib/errors";
import type { SessionUser } from "@/server/auth/session";
import { hasPermission } from "@/server/auth/permissions";

const CORRECTION_ACTIONS = [
  "FINALIZED_SCHEDULE_UNLOCKED",
  "FINALIZED_CORRECTION_ENDED",
  "PUBLISHED_SCHEDULE_UNLOCKED",
  "PUBLISHED_CORRECTION_ENDED",
] as const;

/** Server-side TTL (30 min default; env-overridable for deterministic tests). */
function correctionTtlMs(): number {
  const raw = Number(process.env.PNK_SCHEDULE_CORRECTION_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 60 * 1000;
}

interface CorrectionGrant {
  weekId: string;
  holderId: string;
  role: "FINALIZED" | "PUBLISHED";
  reason: string;
  startedAt: Date;
  expired: boolean;
  expiresAt: Date;
}

async function activeCorrection(tx: Database | undefined, weekId: string): Promise<CorrectionGrant | null> {
  const db = tx ?? getDb();
  const ttl = correctionTtlMs();
  const rows = await db
    .select({
      action: auditLogs.action,
      userId: auditLogs.userId,
      reason: auditLogs.reason,
      createdAt: auditLogs.createdAt,
      // ONE CLOCK DOMAIN: PostgreSQL decides expiry by comparing its own
      // clock_timestamp() against the audit row's DB-authored created_at.
      // Node's Date.now() must never be compared with a database timestamp —
      // the two clocks differ by a measured 4–11 ms on this project's clusters,
      // which is enough for a TTL=0 grant to read as "still active" and
      // intermittently authorize a write. `elapsed >= ttl` is exactly
      // `created_at + ttl <= now`: no grace period, and TTL=0 is
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
  if (!last) return null;
  if (last.action === "FINALIZED_CORRECTION_ENDED" || last.action === "PUBLISHED_CORRECTION_ENDED") return null;
  if (last.expired) return null; // TTL elapsed → locked again (DB-decided, see above)
  const startedAt = last.createdAt;
  // Display value only — derived from the DB-authored start, never a gate.
  const expiresAt = new Date(startedAt.getTime() + ttl);
  return {
    weekId,
    holderId: last.userId ?? "",
    role: last.action === "FINALIZED_SCHEDULE_UNLOCKED" ? "FINALIZED" : "PUBLISHED",
    reason: last.reason ?? "",
    startedAt,
    expiresAt,
    expired: false,
  };
}

/** True while an open correction window exists for the week (either kind). */
export async function isScheduleCorrectionActive(weekId: string): Promise<boolean> {
  return (await activeCorrection(undefined, weekId)) !== null;
}

export async function scheduleCorrectionGrantHolder(weekId: string): Promise<string | null> {
  return (await activeCorrection(undefined, weekId))?.holderId ?? null;
}

/**
 * FINALIZED correction — `weeks.unlock` (ADMIN, SUPER_ADMIN, SCHEDULER/ENCODER)
 * + mandatory reason. The week stays FINALIZED; only the grant holder may write
 * assignments until TTL/end.
 */
export async function beginFinalizedCorrection(
  weekId: string,
  reason: string,
  actor: SessionUser,
): Promise<{ weekId: string; expiresAt: Date; status: string }> {
  // The route layer enforces `assignments.write`; the operation gate lives here.
  // FINALIZED revision is authorized by `weeks.unlock`, held by ADMIN,
  // SUPER_ADMIN and SCHEDULER/ENCODER — and never by VIEWER.
  if (!hasPermission(actor.roleCodes, "weeks.unlock")) {
    throw new ForbiddenError("FINALIZED schedule correction requires the weeks.unlock permission");
  }
  if (!reason || !reason.trim()) {
    throw new ValidationError("reason is required to unlock a FINALIZED schedule for correction");
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
    if (row.status !== "FINALIZED") {
      throw new ConflictError(`week is ${row.status}; this correction applies only to FINALIZED weeks`);
    }
    if (await activeCorrection(tx, weekId)) {
      throw new ConflictError("a schedule correction is already active for this week");
    }
    const expiresAt = new Date(Date.now() + correctionTtlMs());
    await audit(
      {
        user: actor,
        action: "FINALIZED_SCHEDULE_UNLOCKED",
        entityType: "week",
        entityId: weekId,
        oldValue: { status: row.status, assignmentsEditable: false },
        newValue: { status: row.status, assignmentsEditable: true, correctionsExpireAt: expiresAt.toISOString() },
        reason: reason.trim(),
      },
      tx as Database,
    );
    return { weekId, expiresAt, status: row.status };
  });
}

function genericFailure(): string {
  return "unlock failed: verify role, secret, and week state";
}

/**
 * SUPER_ADMIN emergency unlock for one PUBLISHED week. Verifies the
 * server-side secret with a timing-safe comparison; a missing/incorrect
 * secret, missing env, or wrong role produces an identical generic failure
 * (no enumeration, no unlock, no audit row). Reason is mandatory.
 */
export async function beginPublishedCorrection(
  weekId: string,
  secret: string,
  reason: string,
  actor: SessionUser,
): Promise<{ weekId: string; expiresAt: Date; status: string }> {
  if (!actor.roleCodes.includes("SUPER_ADMIN")) {
    throw new ForbiddenError(genericFailure());
  }
  const expected = process.env.PNK_SUPER_ADMIN_SECRET;
  if (typeof expected !== "string" || expected.length === 0) {
    throw new ForbiddenError(genericFailure()); // fail closed
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new ForbiddenError(genericFailure());
  }
  const a = createHash("sha256").update(secret).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(a, b)) {
    throw new ForbiddenError(genericFailure());
  }
  if (!reason || !reason.trim()) {
    throw new ValidationError("reason is required to unlock a PUBLISHED schedule");
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
    if (row.status !== "PUBLISHED") {
      throw new ConflictError(`week is ${row.status}; PUBLISHED unlock applies only to PUBLISHED weeks`);
    }
    if (await activeCorrection(tx, weekId)) {
      throw new ConflictError("a schedule correction is already active for this week");
    }
    const expiresAt = new Date(Date.now() + correctionTtlMs());
    await audit(
      {
        user: actor,
        action: "PUBLISHED_SCHEDULE_UNLOCKED",
        entityType: "week",
        entityId: weekId,
        oldValue: { status: row.status, assignmentsEditable: false },
        newValue: { status: row.status, assignmentsEditable: true, correctionsExpireAt: expiresAt.toISOString() },
        reason: reason.trim(),
      },
      tx as Database,
    );
    return { weekId, expiresAt, status: row.status };
  });
}

/**
 * End either correction window. FINALIZED: any `weeks.unlock` holder (ADMIN,
 * SUPER_ADMIN, SCHEDULER/ENCODER). PUBLISHED: SUPER_ADMIN only. The week
 * returns to its locked state; the status column is never written.
 */
export async function endScheduleCorrection(weekId: string, actor: SessionUser): Promise<void> {
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
    if (!grant) throw new ConflictError("no schedule correction is active for this week");
    const isFinalized = grant.role === "FINALIZED";
    const privileged = isFinalized
      ? hasPermission(actor.roleCodes, "weeks.unlock")
      : actor.roleCodes.includes("SUPER_ADMIN");
    if (!privileged) {
      throw new ForbiddenError("ending this correction requires the authorizing role");
    }
    await audit(
      {
        user: actor,
        action: isFinalized ? "FINALIZED_CORRECTION_ENDED" : "PUBLISHED_CORRECTION_ENDED",
        entityType: "week",
        entityId: weekId,
        oldValue: { status: row.status, assignmentsEditable: true },
        newValue: { status: row.status, assignmentsEditable: false },
        reason: grant.reason,
      },
      tx as Database,
    );
  });
}

/**
 * Assignment-mutation gate. DRAFT → open; FINALIZED/PUBLISHED → require an
 * active correction grant held by the caller. `assertWeekMutable` (DRAFT-only)
 * remains untouched and keeps guarding generation/regeneration.
 */
export async function assertScheduleCorrectable(tx: Database, weekId: string, actor: SessionUser): Promise<void> {
  const rows = await tx
    .select({ status: weeks.status })
    .from(weeks)
    .where(eq(weeks.id, weekId))
    .limit(1);
  const status = rows[0]?.status;
  if (!status) throw new NotFoundError("week not found");
  if (status === "DRAFT") return; // normal mutability
  if (status !== "FINALIZED" && status !== "PUBLISHED") {
    throw new ConflictError(`week is ${status}`);
  }
  const grant = await activeCorrection(tx, weekId);
  if (!grant) {
    throw new ConflictError(`week is ${status}; assignment corrections require an authorized correction window`);
  }
  if (grant.holderId !== actor.userId) {
    throw new ForbiddenError("schedule correction is active but held by another user");
  }
}

/**
 * Group 4 — batched active-correction lookup for many weeks in ONE query.
 * The annual dashboard needs to know, for every week of the year, whether an
 * authorized window is open and who holds it, so its cells can be gated on the
 * same rule the server enforces. Never per-week/per-cell round trips.
 *
 * Deliberately read-only: no audit row is written and no grant is created.
 */
export async function listActiveScheduleCorrections(
  weekIds: string[],
): Promise<Record<string, { role: "FINALIZED" | "PUBLISHED"; holderId: string; expiresAt: string }>> {
  if (weekIds.length === 0) return {};
  const ttl = correctionTtlMs();
  const rows = await getDb()
    .select({
      entityId: auditLogs.entityId,
      action: auditLogs.action,
      userId: auditLogs.userId,
      createdAt: auditLogs.createdAt,
      // Same DB-decided, single-clock-domain expiry as activeCorrection().
      expired: sql<boolean>`extract(epoch from (clock_timestamp() - ${auditLogs.createdAt})) * 1000 >= ${ttl}`,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "week"),
        inArray(auditLogs.entityId, weekIds),
        inArray(auditLogs.action, [...CORRECTION_ACTIONS]),
      ),
    )
    .orderBy(desc(auditLogs.createdAt));

  // Newest first: the first row seen per week is its current grant state.
  const out: Record<string, { role: "FINALIZED" | "PUBLISHED"; holderId: string; expiresAt: string }> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const weekId = row.entityId;
    if (!weekId || seen.has(weekId)) continue;
    seen.add(weekId);
    if (row.action === "FINALIZED_CORRECTION_ENDED" || row.action === "PUBLISHED_CORRECTION_ENDED") continue;
    if (row.expired) continue; // TTL elapsed → locked again (DB-decided)
    out[weekId] = {
      role: row.action === "FINALIZED_SCHEDULE_UNLOCKED" ? "FINALIZED" : "PUBLISHED",
      holderId: row.userId ?? "",
      // Display value only — derived from the same DB-authored start.
      expiresAt: new Date(row.createdAt.getTime() + ttl).toISOString(),
    };
  }
  return out;
}

/** UI helper: correction-window state for a week. */
export async function getScheduleCorrectionState(weekId: string): Promise<{
  active: boolean;
  role: "FINALIZED" | "PUBLISHED" | null;
  holderId: string | null;
  expiresAt: string | null;
}> {
  const grant = await activeCorrection(undefined, weekId);
  return {
    active: grant !== null,
    role: grant?.role ?? null,
    holderId: grant?.holderId ?? null,
    expiresAt: grant?.expiresAt.toISOString() ?? null,
  };
}
