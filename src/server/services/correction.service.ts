/**
 * Master Consolidated Plan E-1/E-2 — schedule correction architecture.
 *
 * Two gateways over the SAME audit-derived, TTL-scoped grant mechanism proven
 * in the Phase 3 availability correction (audit trail decides the active
 * state; week status column is never written; single grant holder; row-locked
 * transitions):
 *
 *   • FINALIZED weeks — authorized correction (Invariant 6). ADMIN with
 *     `weeks.unlock`. Audited FINALIZED_SCHEDULE_UNLOCKED /
 *     FINALIZED_CORRECTION_ENDED. The week REMAINS FINALIZED throughout;
 *     nothing requires reverting to DRAFT.
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
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import { auditLogs, weeks } from "@/server/db/schema";
import { audit } from "./audit.service";
import { ForbiddenError, NotFoundError, ConflictError, ValidationError } from "@/lib/errors";
import type { SessionUser } from "@/server/auth/session";

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
  const rows = await db
    .select({
      action: auditLogs.action,
      userId: auditLogs.userId,
      reason: auditLogs.reason,
      createdAt: auditLogs.createdAt,
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
  const startedAt = last.createdAt;
  const expiresAt = new Date(startedAt.getTime() + correctionTtlMs());
  if (expiresAt.getTime() < Date.now()) return null; // TTL elapsed → locked again
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
 * FINALIZED correction — ADMIN + `weeks.unlock` + mandatory reason. The week
 * stays FINALIZED; only the grant holder may write assignments until TTL/end.
 */
export async function beginFinalizedCorrection(
  weekId: string,
  reason: string,
  actor: SessionUser,
): Promise<{ weekId: string; expiresAt: Date; status: string }> {
  // Route layer enforces the weeks.unlock permission; here the role gate.
  if (!actor.roleCodes.includes("ADMIN") && !actor.roleCodes.includes("SUPER_ADMIN")) {
    throw new ForbiddenError("FINALIZED schedule correction requires an administrator");
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
 * End either correction window. FINALIZED: ADMIN with weeks.unlock.
 * PUBLISHED: SUPER_ADMIN. The week returns to its locked state; the status
 * column is never written.
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
      ? actor.roleCodes.includes("ADMIN") || actor.roleCodes.includes("SUPER_ADMIN")
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
