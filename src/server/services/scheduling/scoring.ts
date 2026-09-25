/**
 * Phase 4 — fairness scoring (§8) and allocation (§9).
 *
 * Scoring is a strict lexicographic chain — the primary fairness factor is
 * the lowest historical Teacher × Dako × Type count (spec §9); secondary
 * factors break ties in a fixed order ending in teacherCode so generation
 * is fully deterministic (§12). No randomness anywhere.
 */
import type {
  AllocationPlan,
  AssignmentType,
  CandidateTeacher,
  SchedulingContext,
  ScheduleDako,
  SlotResult,
  UnassignedReasonCode,
} from "./types";
import { evaluateCandidate } from "./eligibility";

/**
 * Comparison key for one candidate against a specific slot. Lower = better.
 * Chain (§8): primary t×d×type count, then totals, same-dako repeats,
 * same-type repeats, consecutive-same-dako, recency, current-destination
 * preference, and finally teacherCode for determinism (§12).
 */
export function candidateKey(
  candidate: CandidateTeacher,
  dako: ScheduleDako,
  type: AssignmentType,
  ctx: SchedulingContext,
): number[] {
  const c = ctx.counts.get(`${candidate.teacherId}|${dako.dakoId}|${type}`);
  const total = [...ctx.counts.entries()]
    .filter(([k]) => k.startsWith(`${candidate.teacherId}|`))
    .reduce((n, [, v]) => n + v.total, 0);
  const sameDako = [...ctx.counts.entries()]
    .filter(([k]) => k.startsWith(`${candidate.teacherId}|${dako.dakoId}|`))
    .reduce((n, [, v]) => n + v.total, 0);
  const sameType = [...ctx.counts.entries()]
    .filter(([k]) => k.startsWith(`${candidate.teacherId}|`) && k.endsWith(`|${type}`))
    .reduce((n, [, v]) => n + v.total, 0);
  const assignedPrevDako = ctx.prevWeekAssignment.get(candidate.teacherId);
  const consecutive = assignedPrevDako === dako.dakoId ? 1 : 0;
  const recency = assignedPrevDako ? 1 : 0;
  const destinationPref = candidate.currentDestinationId === dako.dakoId ? 0 : 1; // prefer own destination
  return [
    c?.total ?? 0,
    total,
    sameDako,
    sameType,
    consecutive,
    recency,
    destinationPref,
  ];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/** Eligible candidates for a slot, sorted by the fairness chain (best first). */
export function rankedEligible(
  teachers: CandidateTeacher[],
  dako: ScheduleDako,
  type: AssignmentType,
  ctx: SchedulingContext,
): { ranked: CandidateTeacher[]; excludedByRule: Record<string, number> } {
  const excludedByRule: Record<string, number> = {};
  const eligible: CandidateTeacher[] = [];
  for (const t of teachers) {
    const { eligible: ok, violatedRules } = evaluateCandidate(t, dako, ctx);
    if (ok) eligible.push(t);
    else for (const r of violatedRules) excludedByRule[r] = (excludedByRule[r] ?? 0) + 1;
  }
  const withKeys = eligible.map((t) => ({
    t,
    key: candidateKey(t, dako, type, ctx),
  }));
  withKeys.sort((a, b) => {
    const c = compareKeys(a.key, b.key);
    if (c !== 0) return c;
    return a.t.teacherCode.localeCompare(b.t.teacherCode); // deterministic final tie-break
  });
  return { ranked: withKeys.map((w) => w.t), excludedByRule };
}

const TYPE_PRIORITY: AssignmentType[] = ["SUGO", "RESERBA", "RESERBA_II"];

/**
 * Update #6 — Priority-Dako processing order for one allocation pass.
 * Priority dakos are attempted FIRST (their teachers come from the same shared
 * pool, so they win the best candidates); remaining dakos follow in the
 * existing deterministic dakoCode order. SUGO ordering is untouched. Priority
 * is PRECEDENCE, never an alphabetical/sequential renumbering.
 */
export function passOrder(dakos: ScheduleDako[]): ScheduleDako[] {
  return [...dakos].sort((a, b) => {
    const pa = a.isPriority ? 0 : 1;
    const pb = b.isPriority ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.dakoCode.localeCompare(b.dakoCode);
  });
}

function emptySlot(
  dako: ScheduleDako,
  type: AssignmentType,
  reasonCode: UnassignedReasonCode,
  reason: string,
  poolSize: number,
  excludedByRule: Record<string, number>,
): SlotResult {
  return {
    dakoId: dako.dakoId,
    dakoCode: dako.dakoCode,
    dakoName: dako.dakoName,
    assignmentType: type,
    teacherId: null,
    teacherCode: null,
    fullName: null,
    score: null,
    reasonCode,
    reason,
    candidateStats: { poolSize, excludedByRule },
  };
}

function filledSlot(
  dako: ScheduleDako,
  type: AssignmentType,
  teacher: CandidateTeacher,
  ctx: SchedulingContext,
): SlotResult {
  const key = candidateKey(teacher, dako, type, ctx);
  return {
    dakoId: dako.dakoId,
    dakoCode: dako.dakoCode,
    dakoName: dako.dakoName,
    assignmentType: type,
    teacherId: teacher.teacherId,
    teacherCode: teacher.teacherCode,
    fullName: teacher.fullName,
    score: key[0] ?? 0,
    reasonCode: null,
    reason: null,
    candidateStats: { poolSize: ctx.teachers.length, excludedByRule: {} },
  };
}

function reasonForExclusions(excludedByRule: Record<string, number>): {
  code: UnassignedReasonCode;
  reason: string;
} {
  if ((excludedByRule["PREVIOUS_WEEK_ABSENT"] ?? 0) > 0) {
    return {
      code: "ALL_ABSENT_LAST_WEEK",
      reason:
        "Eligible teachers were excluded because they were absent last week (§5 hard rule).",
    };
  }
  if ((excludedByRule["LANGUAGE_MISMATCH"] ?? 0) > 0) {
    return {
      code: "LANGUAGE_MISMATCH",
      reason: "No teacher satisfies the Dako language requirement.",
    };
  }
  return {
    code: "NO_ELIGIBLE_CANDIDATES",
    reason: "No eligible teacher available for this slot.",
  };
}

/**
 * Pure allocation (§9 — approved LEFTOVER-POOL rule):
 *  1. Every ACTIVE Dako attempts SUGO then RESERBA from the shared pool
 *     (dakos processed in dakoCode order; assigned teachers removed at once).
 *  2. Only AFTER all SUGO+RESERBA allocations, remaining teachers form the
 *     leftover pool; each Dako then attempts RESERBA_II from leftovers only.
 *  3. Never steal teachers from SUGO/RESERBA. Empty leftover pool → RESERBA_II
 *     is UNASSIGNED with INSUFFICIENT_FOR_RESERBA_II.
 */
export function allocate(ctx: SchedulingContext): AllocationPlan {
  const activeDakos = [...ctx.dakos]
    .filter((d) => d.status === "ACTIVE")
    .sort((a, b) => a.dakoCode.localeCompare(b.dakoCode));
  const slots: SlotResult[] = [];
  // Pool = all teachers minus those holding immovable MANUAL/OVERRIDE rows.
  // AUTO rows are replaceable and their teachers remain allocatable.
  const remaining = new Set(
    ctx.teachers.filter((t) => !ctx.immovableTeachers.has(t.teacherId)).map((t) => t.teacherId),
  );
  const byId = new Map(ctx.teachers.map((t) => [t.teacherId, t]));
  // Slots held by surviving MANUAL/OVERRIDE assignments are engine-skipped (§13).
  const isOccupied = (dakoId: string, type: AssignmentType) =>
    ctx.occupiedSlots.has(`${dakoId}|${type}`);

  const tryFill = (
    dako: ScheduleDako,
    type: AssignmentType,
    pool: Set<string>,
  ): SlotResult => {
    const poolTeachers = [...pool].map((id) => byId.get(id)!);
    const { ranked, excludedByRule } = rankedEligible(poolTeachers, dako, type, ctx);
    const best = ranked[0];
    if (!best) {
      const anyTeacher = poolTeachers.length > 0;
      const { code, reason } = anyTeacher
        ? reasonForExclusions(excludedByRule)
        : { code: "NO_ELIGIBLE_CANDIDATES" as const, reason: "No eligible teacher available for this slot." };
      return emptySlot(dako, type, code, reason, poolTeachers.length, excludedByRule);
    }
    pool.delete(best.teacherId);
    return filledSlot(dako, type, best, ctx);
  };

  // Pass 1: SUGO for every active Dako (existing dakoCode order — untouched).
  for (const dako of activeDakos) {
    if (!isOccupied(dako.dakoId, "SUGO")) slots.push(tryFill(dako, "SUGO", remaining));
  }

  // Pass 2: RESERBA — Update #6: Priority Dako receive assignment priority
  // first; remaining assignments follow the existing fair-rotation logic.
  for (const dako of passOrder(activeDakos)) {
    if (!isOccupied(dako.dakoId, "RESERBA")) slots.push(tryFill(dako, "RESERBA", remaining));
  }

  // Pass 3: RESERBA_II from the leftover pool ONLY (approved §9/§4 refinement).
  // Update #6: Priority Dako receive the remaining RESERBA II teachers first.
  for (const dako of passOrder(activeDakos)) {
    if (isOccupied(dako.dakoId, "RESERBA_II")) continue;
    if (remaining.size === 0) {
      slots.push(
        emptySlot(
          dako,
          "RESERBA_II",
          "INSUFFICIENT_FOR_RESERBA_II",
          "Insufficient eligible teachers for RESERBA_II (leftover pool empty after SUGO and RESERBA).",
          0,
          {},
        ),
      );
      continue;
    }
    slots.push(tryFill(dako, "RESERBA_II", remaining));
  }

  const summary = {
    dakos: activeDakos.length,
    sugoAssigned: slots.filter((s) => s.assignmentType === "SUGO" && s.teacherId).length,
    reserbaAssigned: slots.filter((s) => s.assignmentType === "RESERBA" && s.teacherId).length,
    reserbaIiAssigned: slots.filter((s) => s.assignmentType === "RESERBA_II" && s.teacherId).length,
    unassigned: slots.filter((s) => !s.teacherId).length,
  };
  return { slots, summary };
}
