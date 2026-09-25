/**
 * Guro Duty (Destinado / Katuwang) — duty-based generation planner.
 * Pure logic (no DB) — unit-testable like the rest of the scheduling core.
 *
 * Modes (per applicable Dako — a dako whose duty roster is its own
 * `currentDestinationId` holders; never cross-dako):
 *   ASSIGN_DESTINADO — Destinado → SUGO, Katuwang → RESERBA,
 *                      additional Katuwang → RESERBA_II.
 *   ASSIGN_KATUWANG  — Katuwang → SUGO, Destinado → RESERBA,
 *                      additional Katuwang → RESERBA_II.
 *
 * Hard eligibility (scheduling/eligibility — oath date, master status,
 * weekly availability, language, previous-week absence, ...) is ALWAYS
 * evaluated first and is never bypassed to satisfy a duty preference. Fair
 * rotation is per-dako and fully deterministic (ordered per slot being filled):
 *   1. prior picks FOR THIS SLOT through this mode at this dako, ASC (SUGO
 *      picks for SUGO, RESERBA-II picks for RESERBA_II, RESERBA picks for
 *      RESERBA);
 *   2. total prior picks through this mode at this dako, ASC — nobody serves
 *      twice while another eligible Katuwang is unserved;
 *   3. most recent pick through this mode at this dako, ASC (never picked
 *      first, then longest-ago first);
 *   4. most recent assignment at this dako (any source), ASC;
 *   5. teacherCode, ASC (stable tie-break).
 * No randomness anywhere — the outcome is reproducible and auditable.
 */
import { evaluateCandidate } from "./eligibility";
import type {
  AssignmentType,
  CandidateTeacher,
  SchedulingContext,
  UnassignedReasonCode,
} from "./types";

export type DutyMode = "ASSIGN_DESTINADO" | "ASSIGN_KATUWANG";
export type TeacherDuty = "DESTINADO" | "KATUWANG";

export interface DutyRotationStats {
  /** # of SUGO picks through THIS generation mode at this dako. */
  sugoPicks: number;
  /** # of RESERBA picks through THIS generation mode at this dako. */
  reserbaPicks: number;
  /** # of RESERBA_II picks through THIS generation mode at this dako. */
  reserbaIiPicks: number;
  /** Most recent pick through this mode at this dako (ISO text) or null. */
  lastPickedAt: string | null;
}

export function zeroRotation(): DutyRotationStats {
  return { sugoPicks: 0, reserbaPicks: 0, reserbaIiPicks: 0, lastPickedAt: null };
}

export interface DutySlotPlan {
  dakoId: string;
  dakoCode: string;
  dakoName: string;
  assignmentType: AssignmentType;
  teacherId: string | null;
  teacherCode: string | null;
  fullName: string | null;
  /** Which duty filled (or should have filled) this slot. */
  duty: TeacherDuty | null;
  reasonCode: UnassignedReasonCode | null;
  reason: string | null;
  /** Rotation stats of the winner — the fair-rotation decision trail. */
  rotation: DutyRotationStats | null;
}

export interface DutyPlan {
  slots: DutySlotPlan[];
  applicableDakos: number;
  inserted: number;
}

/** Most recent assignment at this dako from the historical counts (any source). */
function lastAssignmentAt(ctx: SchedulingContext, teacherId: string, dakoId: string): string {
  let last = "";
  for (const type of ["SUGO", "RESERBA", "RESERBA_II"] as AssignmentType[]) {
    const at = ctx.counts.get(`${teacherId}|${dakoId}|${type}`)?.lastAssignedAt ?? "";
    if (at > last) last = at;
  }
  return last;
}

/** Prior picks for the slot being filled — the per-slot fairness factor. */
function picksFor(r: DutyRotationStats, slot: AssignmentType): number {
  return slot === "SUGO" ? r.sugoPicks : slot === "RESERBA_II" ? r.reserbaIiPicks : r.reserbaPicks;
}

function totalPicks(r: DutyRotationStats): number {
  return r.sugoPicks + r.reserbaPicks + r.reserbaIiPicks;
}

function compareRotation(
  a: { t: CandidateTeacher; r: DutyRotationStats },
  b: { t: CandidateTeacher; r: DutyRotationStats },
  ctx: SchedulingContext,
  dakoId: string,
  slot: AssignmentType,
): number {
  return (
    picksFor(a.r, slot) - picksFor(b.r, slot) ||
    // nobody serves twice while another eligible Katuwang is unserved.
    totalPicks(a.r) - totalPicks(b.r) ||
    // never-picked ("") sorts first; then longest-ago first.
    (a.r.lastPickedAt ?? "").localeCompare(b.r.lastPickedAt ?? "") ||
    lastAssignmentAt(ctx, a.t.teacherId, dakoId).localeCompare(
      lastAssignmentAt(ctx, b.t.teacherId, dakoId),
    ) ||
    a.t.teacherCode.localeCompare(b.t.teacherCode)
  );
}

function slotLayout(mode: DutyMode): { type: AssignmentType; duty: TeacherDuty }[] {
  return [
    { type: "SUGO", duty: mode === "ASSIGN_KATUWANG" ? "KATUWANG" : "DESTINADO" },
    { type: "RESERBA", duty: mode === "ASSIGN_KATUWANG" ? "DESTINADO" : "KATUWANG" },
    { type: "RESERBA_II", duty: "KATUWANG" },
  ];
}

export function planDutyAssignments(
  ctx: SchedulingContext,
  mode: DutyMode,
  rotation: Map<string, DutyRotationStats>,
): DutyPlan {
  const slots: DutySlotPlan[] = [];
  // Week-wide single use (matches assignments_week_teacher_key) — a teacher
  // fills at most one slot per generated week, across dakos.
  const usedThisRound = new Set<string>();
  let applicableDakos = 0;

  const dakos = [...ctx.dakos].sort((a, b) => a.dakoCode.localeCompare(b.dakoCode));
  for (const dakoRow of dakos) {
    // Applicable dako = has its OWN duty roster (duty holders whose Current
    // Destination is this dako). Never borrow a teacher from another dako to
    // fill a slot.
    const roster = ctx.teachers.filter(
      (t) => t.currentDestinationId === dakoRow.dakoId && t.duty != null,
    );
    if (roster.length === 0) continue;
    applicableDakos += 1;
    const pickedHere = new Set<string>();

    for (const slot of slotLayout(mode)) {
      // MANUAL/OVERRIDE slots are immovable — never touched.
      if (ctx.occupiedSlots.has(`${dakoRow.dakoId}|${slot.type}`)) continue;

      const pool = roster.filter(
        (t) =>
          t.duty === slot.duty && !usedThisRound.has(t.teacherId) && !pickedHere.has(t.teacherId),
      );

      const eligible: { t: CandidateTeacher; r: DutyRotationStats }[] = [];
      const excluded: Record<string, number> = {};
      for (const t of pool) {
        const check = evaluateCandidate(t, dakoRow, ctx);
        if (check.eligible) {
          eligible.push({
            t,
            r: rotation.get(`${t.teacherId}|${dakoRow.dakoId}`) ?? zeroRotation(),
          });
        } else {
          for (const rule of check.violatedRules) excluded[rule] = (excluded[rule] ?? 0) + 1;
        }
      }
      eligible.sort((a, b) => compareRotation(a, b, ctx, dakoRow.dakoId, slot.type));

      const winner = eligible[0];
      if (winner) {
        usedThisRound.add(winner.t.teacherId);
        pickedHere.add(winner.t.teacherId);
        slots.push({
          dakoId: dakoRow.dakoId,
          dakoCode: dakoRow.dakoCode,
          dakoName: dakoRow.dakoName,
          assignmentType: slot.type,
          teacherId: winner.t.teacherId,
          teacherCode: winner.t.teacherCode,
          fullName: winner.t.fullName,
          duty: slot.duty,
          reasonCode: null,
          reason: null,
          rotation: winner.r,
        });
        continue;
      }

      const rules = Object.entries(excluded)
        .map(([rule, n]) => `${rule} ×${n}`)
        .join(", ");
      slots.push({
        dakoId: dakoRow.dakoId,
        dakoCode: dakoRow.dakoCode,
        dakoName: dakoRow.dakoName,
        assignmentType: slot.type,
        teacherId: null,
        teacherCode: null,
        fullName: null,
        duty: slot.duty,
        reasonCode: "NO_ELIGIBLE_CANDIDATES",
        reason:
          pool.length === 0
            ? `no ${slot.duty} in this dako's duty roster`
            : `no eligible ${slot.duty} (${rules || "all candidates excluded"})`,
        rotation: null,
      });
    }
  }

  const inserted = slots.filter((s) => s.teacherId !== null).length;
  return { slots, applicableDakos, inserted };
}
