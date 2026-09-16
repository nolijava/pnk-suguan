/**
 * Phase 4 — pure eligibility evaluation (§4/§5).
 * Hard rules are never bypassed by the automatic engine and never scored
 * around; manual ADMIN override is handled at the assignment-service layer.
 */
import { isTeacherEligibleForDako, type Language } from "@/lib/eligibility";
import type {
  CandidateTeacher,
  HardRuleCode,
  SchedulingContext,
  EligibilityCheckResult,
  ScheduleDako,
} from "./types";

/** All hard-rule violations for (teacher, dako, week context) — the single evaluator. */
export function evaluateCandidate(
  candidate: CandidateTeacher,
  dako: ScheduleDako,
  ctx: SchedulingContext,
): { eligible: boolean; violatedRules: HardRuleCode[] } {
  const violated: HardRuleCode[] = [];

  const assigned = ctx.weekAssignments.get(candidate.teacherId);
  if (assigned) violated.push("ALREADY_ASSIGNED_THIS_WEEK");

  // A. Teacher master status (§5.A) — authoritative, cannot be overridden by weekly state.
  if (candidate.status !== "ACTIVE") violated.push("TEACHER_INACTIVE_MASTER");

  // B. Dako master status (§5.B) — non-overrideable even manually.
  if (dako.status !== "ACTIVE") violated.push("DAKO_DISABLED");

  // C. Weekly availability (§5.C): AVAILABLE only; NOT_ENCODED not eligible (§7).
  const avail = ctx.availability.get(candidate.teacherId);
  if (!avail) violated.push("NOT_ENCODED");
  else if (avail.status === "ABSENT") violated.push("WEEKLY_ABSENT");
  else if (avail.status === "INACTIVE") violated.push("WEEKLY_INACTIVE");
  else if (avail.status !== "AVAILABLE") violated.push("NOT_ENCODED");

  // D. Previous-week ABSENT → hard exclude from AUTOMATIC scheduling (§5.D).
  if (ctx.prevWeekAbsent.has(candidate.teacherId)) violated.push("PREVIOUS_WEEK_ABSENT");

  // E. Language (§5.E): Filipino teacher → Filipino dako only.
  if (!isTeacherEligibleForDako(candidate.language as Language, dako.language as Language)) {
    violated.push("LANGUAGE_MISMATCH");
  }

  return { eligible: violated.length === 0, violatedRules: violated };
}

/** API-facing check for the manual-assignment/override warning flow (§15). */
export function eligibilityCheck(
  teacher: CandidateTeacher,
  dako: ScheduleDako,
  ctx: SchedulingContext,
): EligibilityCheckResult {
  const { eligible, violatedRules } = evaluateCandidate(teacher, dako, ctx);
  // DAKO_DISABLED is structural: even ADMIN override is refused (createAssignment
  // refuses non-ACTIVE dako outright; matching the automatic rule).
  const overrideAllowed = !violatedRules.includes("DAKO_DISABLED");
  return { eligible, violatedRules, overrideAllowed };
}
