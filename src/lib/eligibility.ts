export type Language = "FILIPINO" | "ENGLISH";

/**
 * §22 Language eligibility:
 *  - English teacher: may serve English and Filipino dako.
 *  - Filipino teacher: may serve Filipino dako only.
 * Single source of truth — used by both the manual assignment flow and
 * (later) the scheduling engine.
 */
export function isTeacherEligibleForDako(
  teacherLanguage: Language,
  dakoLanguage: Language,
): boolean {
  if (dakoLanguage === "FILIPINO") return true;
  return teacherLanguage === "ENGLISH";
}

/**
 * Phase 5 — hard rules that NO assignment path may override, not even ADMIN
 * (create / change / ADMIN override / API / future paths).
 *
 *  - DAKO_DISABLED was already documented as structural in Phase 4
 *    (`overrideAllowed: false`); the gate below closes the latent gap that
 *    let an ADMIN override reason bypass it on the create path.
 *  - LANGUAGE_MISMATCH is now an ABSOLUTE business rule (Phase 5 §14):
 *    an ENGLISH dako accepts ENGLISH teachers only. FILIPINO teacher →
 *    ENGLISH dako is never allowed; the only path to eligibility is editing
 *    the teacher's language to ENGLISH in their Phase 2 profile.
 */
// Update #5 — OATH_DATE_NOT_REACHED is ABSOLUTE (user-decided): a teacher must
// never receive a NEW assignment dated before their Panunumpa/oath-taking date,
// and no actor (ADMIN included) and no reason may bypass it.
export const NON_OVERRIDEABLE_RULES = ["DAKO_DISABLED", "LANGUAGE_MISMATCH", "OATH_DATE_NOT_REACHED"] as const;

export function isNonOverrideableRule(rule: string): boolean {
  return (NON_OVERRIDEABLE_RULES as readonly string[]).includes(rule);
}
